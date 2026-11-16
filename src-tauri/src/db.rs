// ---------------------------------------------------------------------------------------------
// Ayudas para trabajar con libsql (SQLite local hoy, Turso más adelante).
//
// libsql entra en pánico (`unreachable!`) si se lee una columna con un tipo distinto al guardado,
// p. ej. leer como f64 un `COALESCE(SUM(total), 0)` que devuelve el entero 0 cuando no hay filas.
// Por eso las columnas se leen siempre con `col`, que convierte entre enteros y decimales y devuelve
// un error (nunca un pánico) si el tipo no corresponde.
// ---------------------------------------------------------------------------------------------

use libsql::params::IntoParams;
use libsql::{Connection, Error, Result, Row, Value};

pub trait Columna: Sized {
    fn desde_valor(valor: Value) -> Result<Self>;
}

impl Columna for Value {
    fn desde_valor(valor: Value) -> Result<Self> {
        Ok(valor)
    }
}

impl Columna for i64 {
    fn desde_valor(valor: Value) -> Result<Self> {
        match valor {
            Value::Integer(i) => Ok(i),
            Value::Real(f) if f.fract() == 0.0 => Ok(f as i64),
            Value::Null => Err(Error::NullValue),
            _ => Err(Error::InvalidColumnType),
        }
    }
}

impl Columna for i32 {
    fn desde_valor(valor: Value) -> Result<Self> {
        i32::try_from(i64::desde_valor(valor)?).map_err(|_| Error::InvalidColumnType)
    }
}

impl Columna for f64 {
    fn desde_valor(valor: Value) -> Result<Self> {
        match valor {
            Value::Real(f) => Ok(f),
            Value::Integer(i) => Ok(i as f64),
            Value::Null => Err(Error::NullValue),
            _ => Err(Error::InvalidColumnType),
        }
    }
}

impl Columna for bool {
    fn desde_valor(valor: Value) -> Result<Self> {
        Ok(i64::desde_valor(valor)? != 0)
    }
}

impl Columna for String {
    fn desde_valor(valor: Value) -> Result<Self> {
        match valor {
            Value::Text(s) => Ok(s),
            Value::Null => Err(Error::NullValue),
            _ => Err(Error::InvalidColumnType),
        }
    }
}

impl<T: Columna> Columna for Option<T> {
    fn desde_valor(valor: Value) -> Result<Self> {
        match valor {
            Value::Null => Ok(None),
            otro => T::desde_valor(otro).map(Some),
        }
    }
}

pub trait FilaExt {
    /// Lee la columna `idx` (desde 0) convirtiéndola al tipo pedido.
    fn col<T: Columna>(&self, idx: i32) -> Result<T>;
}

impl FilaExt for Row {
    fn col<T: Columna>(&self, idx: i32) -> Result<T> {
        T::desde_valor(self.get_value(idx)?)
    }
}

/// Primera fila de la consulta, o None si no devolvió ninguna.
pub async fn una_fila<T>(
    conn: &Connection,
    sql: &str,
    params: impl IntoParams,
    mapear: impl FnOnce(&Row) -> Result<T>,
) -> Result<Option<T>> {
    let mut rows = conn.query(sql, params).await?;
    match rows.next().await? {
        Some(row) => mapear(&row).map(Some),
        None => Ok(None),
    }
}

/// Primera fila de la consulta; error si no devolvió ninguna.
pub async fn fila<T>(
    conn: &Connection,
    sql: &str,
    params: impl IntoParams,
    mapear: impl FnOnce(&Row) -> Result<T>,
) -> Result<T> {
    una_fila(conn, sql, params, mapear).await?.ok_or(Error::QueryReturnedNoRows)
}

/// Todas las filas de la consulta.
pub async fn filas<T>(
    conn: &Connection,
    sql: &str,
    params: impl IntoParams,
    mut mapear: impl FnMut(&Row) -> Result<T>,
) -> Result<Vec<T>> {
    let mut rows = conn.query(sql, params).await?;
    let mut resultado = Vec::new();
    while let Some(row) = rows.next().await? {
        resultado.push(mapear(&row)?);
    }
    Ok(resultado)
}

/// Parámetros con nombre (":nombre") armados dinámicamente para los filtros de búsqueda.
pub fn con_nombre(valores: &[(&'static str, Value)]) -> libsql::params::Params {
    libsql::params::Params::Named(valores.iter().map(|(k, v)| (k.to_string(), v.clone())).collect())
}

/// true si el error es por violar una restricción UNIQUE (p. ej. código o nombre duplicado).
pub fn es_duplicado(err: &Error) -> bool {
    match err {
        Error::SqliteFailure(_, mensaje) | Error::RemoteSqliteFailure(_, _, mensaje) => mensaje.contains("UNIQUE"),
        otro => otro.to_string().contains("UNIQUE constraint"),
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[tokio::test]
    async fn lee_enteros_como_decimales_sin_panico() {
        let db = libsql::Builder::new_local(":memory:").build().await.unwrap();
        let conn = db.connect().unwrap();
        conn.execute("CREATE TABLE t (x REAL, s TEXT)", ()).await.unwrap();

        // Sin filas, COALESCE(SUM(x), 0) devuelve el ENTERO 0: con libsql directo esto entra en pánico.
        let suma: f64 = fila(&conn, "SELECT COALESCE(SUM(x), 0) FROM t", (), |r| r.col(0)).await.unwrap();
        assert_eq!(suma, 0.0);

        conn.execute("INSERT INTO t VALUES (?1, ?2)", libsql::params![2.5, "a"]).await.unwrap();
        let (x, s, nada): (f64, String, Option<i64>) =
            fila(&conn, "SELECT x, s, NULL FROM t", (), |r| Ok((r.col(0)?, r.col(1)?, r.col(2)?))).await.unwrap();
        assert_eq!((x, s.as_str(), nada), (2.5, "a", None));

        // Tipo equivocado: error, no pánico.
        assert!(fila::<i64>(&conn, "SELECT s FROM t", (), |r| r.col(0)).await.is_err());
        assert!(una_fila::<i64>(&conn, "SELECT 1 FROM t WHERE 0", (), |r| r.col(0)).await.unwrap().is_none());

        let err = conn.execute("CREATE UNIQUE INDEX u ON t (s)", ()).await.and(
            conn.execute("INSERT INTO t VALUES (1, 'a')", ()).await,
        );
        assert!(es_duplicado(&err.unwrap_err()));
    }
}
