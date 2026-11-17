// Base de datos en la nube (Turso) compartida entre la laptop y el teléfono.
//
// Cada dispositivo guarda una copia local (réplica embebida de libsql) que se sincroniza con Turso:
// las lecturas salen de la copia local (funcionan sin internet) y las escrituras se envían a Turso
// (necesitan internet). La URL y el token se guardan en el directorio de datos de la app, nunca en
// el código: el repositorio es público.

use std::path::{Path, PathBuf};

use libsql::params::Params;
use libsql::{Connection, Value};
use serde::{Deserialize, Serialize};

use crate::db::{filas, FilaExt};

// Archivo con la URL y el token de Turso (en el directorio de datos de la app).
const ARCHIVO_CONFIG: &str = "nube.json";
// Subcarpeta de la copia local. Va aparte para que buscar_base_existente (que solo mira el
// directorio raíz) no la confunda con una base local.
const CARPETA: &str = "nube";
// Ventas en curso de este dispositivo. Con la nube no se guardan en la base: si no, la laptop y el
// teléfono se pisarían las pestañas del punto de venta.
const ARCHIVO_VENTAS_ABIERTAS: &str = "ventas_abiertas.json";
// Clave de configuración que no se copia entre bases (ver ARCHIVO_VENTAS_ABIERTAS).
pub const CLAVE_NO_COPIAR: &str = "ventas_abiertas";

// Filas por cada INSERT al copiar datos: menos viajes a la nube sin armar sentencias enormes.
const FILAS_POR_INSERT: usize = 100;

#[derive(Serialize, Deserialize, Clone)]
pub struct ConfigNube {
    pub url: String,
    pub token: String,
}

pub fn leer_config(dir: &Path) -> Option<ConfigNube> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(ARCHIVO_CONFIG)).ok()?).ok()
}

pub fn guardar_config(dir: &Path, config: &ConfigNube) -> Result<(), String> {
    let texto = serde_json::to_string(config).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(ARCHIVO_CONFIG), texto)
        .map_err(|e| format!("No se pudo guardar la conexión a la nube: {}", e))
}

// Olvida la conexión: borra la configuración y la copia local. Los datos en Turso no se tocan.
pub fn olvidar(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(ARCHIVO_CONFIG));
    let _ = std::fs::remove_file(dir.join(ARCHIVO_VENTAS_ABIERTAS));
    let _ = std::fs::remove_dir_all(dir.join(CARPETA));
}

pub fn leer_ventas_abiertas(dir: &Path) -> String {
    std::fs::read_to_string(dir.join(ARCHIVO_VENTAS_ABIERTAS)).unwrap_or_default()
}

pub fn guardar_ventas_abiertas(dir: &Path, datos: &str) -> Result<(), String> {
    std::fs::write(dir.join(ARCHIVO_VENTAS_ABIERTAS), datos)
        .map_err(|e| format!("No se pudieron guardar las ventas abiertas: {}", e))
}

// Acepta la URL tal como la muestra Turso (libsql://nombre-usuario.turso.io) o con https://.
pub fn normalizar_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    let host = url
        .strip_prefix("libsql://")
        .or_else(|| url.strip_prefix("https://"))
        .unwrap_or("");
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err("La URL debe empezar con libsql:// (cópiala tal cual desde Turso).".to_string());
    }
    Ok(format!("libsql://{}", host))
}

// Nombre de la base según la URL: "libsql://total-stock-jean.turso.io" -> "total-stock-jean".
pub fn nombre_desde_url(url: &str) -> String {
    let host = url.split("://").nth(1).unwrap_or(url);
    let nombre: String = host
        .split('.')
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if nombre.is_empty() { "nube".to_string() } else { nombre }
}

pub fn ruta_replica(dir: &Path, url: &str) -> PathBuf {
    dir.join(CARPETA).join(format!("{}.db", nombre_desde_url(url)))
}

// Borra el archivo de la copia local y los auxiliares que crea libsql.
pub fn borrar_replica(ruta: &Path) {
    let _ = std::fs::remove_file(ruta);
    for sufijo in ["-wal", "-shm", "-journal", "-info", "-client_wal_index"] {
        let _ = std::fs::remove_file(format!("{}{}", ruta.display(), sufijo));
    }
}

// Conexión HTTPS para hablar con Turso. libsql trae una propia que usa los certificados raíz del
// sistema operativo, pero en Android no los encuentra ("no valid native root CA certificates
// found"); esta usa los certificados incluidos en la app y funciona igual en Windows y Android.
pub fn conector_https() -> hyper_rustls::HttpsConnector<hyper::client::HttpConnector> {
    let mut http = hyper::client::HttpConnector::new();
    http.enforce_http(false);
    http.set_nodelay(true);
    hyper_rustls::HttpsConnectorBuilder::new()
        .with_webpki_roots()
        .https_or_http()
        .enable_http1()
        .wrap_connector(http)
}

// Tiempo máximo esperando a Turso al comprobar la conexión.
const ESPERA_COMPROBAR_CONEXION: std::time::Duration = std::time::Duration::from_secs(5);

// true si Turso responde. Cualquier respuesta HTTP cuenta (aunque sea un error): lo que importa es
// llegar al servidor. El token va igual que en libsql, que consulta esta misma ruta.
pub async fn hay_conexion(config: &ConfigNube) -> bool {
    let url = config.url.replacen("libsql://", "https://", 1);
    let Ok(peticion) = hyper::Request::get(format!("{}/info", url))
        .header("Authorization", format!("Bearer {}", config.token))
        .body(hyper::Body::empty())
    else {
        return false;
    };
    let cliente = hyper::Client::builder().build::<_, hyper::Body>(conector_https());
    matches!(
        tokio::time::timeout(ESPERA_COMPROBAR_CONEXION, cliente.request(peticion)).await,
        Ok(Ok(_))
    )
}

// Convierte los errores de libsql en un mensaje entendible para el usuario.
pub fn mensaje_error(e: impl std::fmt::Display) -> String {
    let texto = e.to_string();
    let minus = texto.to_lowercase();
    if minus.contains("401") || minus.contains("unauthorized") || minus.contains("403") {
        "Turso rechazó el token. Revisa que lo copiaste completo y que sea de lectura y escritura.".to_string()
    } else if minus.contains("404") || minus.contains("not found") {
        "No se encontró esa base en Turso. Revisa la URL.".to_string()
    } else if minus.contains("dns")
        || minus.contains("connect")
        || minus.contains("timed out")
        || minus.contains("network")
    {
        format!("No se pudo conectar con la nube. Revisa tu conexión a internet. ({})", texto)
    } else {
        format!("Error con la base en la nube: {}", texto)
    }
}

// Tablas de la app (sin las internas de SQLite), en el orden en que se crearon.
async fn tablas(conn: &Connection) -> libsql::Result<Vec<String>> {
    filas(
        conn,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'libsql_%' AND name NOT LIKE '_litestream%' ORDER BY rowid",
        (),
        |row| row.col(0),
    )
    .await
}

async fn columnas(conn: &Connection, tabla: &str) -> libsql::Result<Vec<String>> {
    filas(conn, &format!("PRAGMA table_info(\"{}\")", tabla), (), |row| row.col(1)).await
}

// true si hay algo guardado (productos, ventas, clientes...). La tabla de configuración no cuenta:
// una base recién creada ya puede tener ajustes.
pub async fn tiene_datos(conn: &Connection) -> libsql::Result<bool> {
    for tabla in tablas(conn).await? {
        if tabla == "configuracion" {
            continue;
        }
        let sql = format!("SELECT EXISTS(SELECT 1 FROM \"{}\")", tabla);
        let hay: Vec<i64> = filas(conn, &sql, (), |row| row.col(0)).await?;
        if hay.first() == Some(&1) {
            return Ok(true);
        }
    }
    Ok(false)
}

// Borra todas las filas de todas las tablas (para restaurar una copia sobre la base de la nube).
pub async fn vaciar(conn: &Connection) -> libsql::Result<()> {
    for tabla in tablas(conn).await? {
        conn.execute(&format!("DELETE FROM \"{}\"", tabla), ()).await?;
    }
    Ok(())
}

// Copia todas las filas de `origen` a `destino`, tabla por tabla. `destino` ya debe tener el
// esquema (crear_esquema). Solo se copian las columnas que existen en ambas, así una copia de
// seguridad vieja (con menos columnas) también sirve. Conviene llamarla dentro de una transacción.
pub async fn copiar_datos(origen: &Connection, destino: &Connection) -> libsql::Result<()> {
    let tablas_destino = tablas(destino).await?;
    for tabla in tablas(origen).await? {
        if !tablas_destino.contains(&tabla) {
            continue;
        }
        let cols_destino = columnas(destino, &tabla).await?;
        let cols: Vec<String> = columnas(origen, &tabla)
            .await?
            .into_iter()
            .filter(|c| cols_destino.contains(c))
            .collect();
        if cols.is_empty() {
            continue;
        }
        let lista = cols.iter().map(|c| format!("\"{}\"", c)).collect::<Vec<_>>().join(", ");

        let filtro = if tabla == "configuracion" {
            format!(" WHERE clave <> '{}'", CLAVE_NO_COPIAR)
        } else {
            String::new()
        };
        let mut rows = origen
            .query(&format!("SELECT {} FROM \"{}\"{}", lista, tabla, filtro), ())
            .await?;
        let mut datos: Vec<Vec<Value>> = Vec::new();
        while let Some(row) = rows.next().await? {
            let mut fila = Vec::with_capacity(cols.len());
            for i in 0..cols.len() {
                fila.push(row.get_value(i as i32)?);
            }
            datos.push(fila);
        }

        let marcadores = format!("({})", vec!["?"; cols.len()].join(", "));
        for bloque in datos.chunks(FILAS_POR_INSERT) {
            let sql = format!(
                "INSERT OR REPLACE INTO \"{}\" ({}) VALUES {}",
                tabla,
                lista,
                vec![marcadores.as_str(); bloque.len()].join(", ")
            );
            let valores: Vec<Value> = bloque.iter().flatten().cloned().collect();
            destino.execute(&sql, Params::Positional(valores)).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn normaliza_urls_de_turso() {
        assert_eq!(normalizar_url(" libsql://a-b.turso.io/ ").unwrap(), "libsql://a-b.turso.io");
        assert_eq!(normalizar_url("https://a-b.turso.io").unwrap(), "libsql://a-b.turso.io");
        assert!(normalizar_url("a-b.turso.io").is_err());
        assert!(normalizar_url("libsql://").is_err());
        assert_eq!(nombre_desde_url("libsql://total-stock-jean.aws-us-east-1.turso.io"), "total-stock-jean");
    }

    #[tokio::test]
    async fn copia_todas_las_tablas_sin_ventas_abiertas() {
        let a = libsql::Builder::new_local(":memory:").build().await.unwrap();
        let b = libsql::Builder::new_local(":memory:").build().await.unwrap();
        let (ca, cb) = (a.connect().unwrap(), b.connect().unwrap());
        ca.execute_batch(
            "CREATE TABLE productos (id INTEGER PRIMARY KEY, detalle TEXT, precio REAL, extra TEXT);
             CREATE TABLE configuracion (clave TEXT PRIMARY KEY, valor TEXT);
             INSERT INTO configuracion VALUES ('usar_medida', '1'), ('ventas_abiertas', '[1]');",
        )
        .await
        .unwrap();
        for i in 0..250 {
            ca.execute("INSERT INTO productos VALUES (?1, ?2, 1.5, 'x')", libsql::params![i, format!("P{}", i)])
                .await
                .unwrap();
        }
        cb.execute_batch(
            "CREATE TABLE productos (id INTEGER PRIMARY KEY, detalle TEXT, precio REAL);
             CREATE TABLE configuracion (clave TEXT PRIMARY KEY, valor TEXT);",
        )
        .await
        .unwrap();

        assert!(tiene_datos(&ca).await.unwrap());
        assert!(!tiene_datos(&cb).await.unwrap());
        copiar_datos(&ca, &cb).await.unwrap();

        let n: Vec<i64> = filas(&cb, "SELECT count(*) FROM productos", (), |r| r.col(0)).await.unwrap();
        assert_eq!(n, vec![250]);
        let claves: Vec<String> = filas(&cb, "SELECT clave FROM configuracion", (), |r| r.col(0)).await.unwrap();
        assert_eq!(claves, vec!["usar_medida".to_string()]);

        vaciar(&cb).await.unwrap();
        assert!(!tiene_datos(&cb).await.unwrap());
    }
}
