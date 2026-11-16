mod reportes;

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, ToSql};
use serde::{Deserialize, Serialize};
use tauri::Manager;

const PRODUCTOS_POR_PAGINA: i64 = 20;
const VENTAS_POR_PAGINA: i64 = 20;
const RESULTADOS_BUSQUEDA_VENTA: i64 = 8;

// Valores válidos para el campo iva: sin IVA, 15%, 5% o exento.
const OPCIONES_IVA: [&str; 4] = ["SIN_IVA", "IVA_15", "IVA_5", "EXENTO"];

#[derive(Clone, Serialize)]
struct Producto {
    id: i64,
    codigo: String,
    detalle: String,
    categoria: String,
    precio: f64,
    iva: String,
    stock: i32,
    // Medida opcional (p. ej. "500 ML", "1 KG", "TALLA M"). Vacío si no aplica.
    medida: String,
    // Aplicación opcional: para qué sirve o con qué es compatible (p. ej. "IPHONE 13, 14"). Vacío si no aplica.
    aplicacion: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ajustes {
    // Si está activo, el catálogo muestra y permite editar el campo "Medida".
    usar_medida: bool,
    // Si está activo, el catálogo muestra y permite editar el campo "Aplicación".
    usar_aplicacion: bool,
}

#[derive(Serialize)]
struct PaginaProductos {
    productos: Vec<Producto>,
    total: i64,
    pagina: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Movimiento {
    id: i64,
    tipo: String,
    cantidad: i32,
    stock_resultante: i32,
    fecha: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InfoBaseDatos {
    nombre: String,
    ruta: String,
    total_productos: i64,
}

// La conexión es None hasta que el usuario crea la base de datos en el primer inicio.
struct AppState {
    db: Mutex<Option<Connection>>,
}

fn abrir_base_de_datos(ruta: PathBuf) -> rusqlite::Result<Connection> {
    let conn = Connection::open(ruta)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS productos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            codigo TEXT NOT NULL,
            detalle TEXT NOT NULL,
            categoria TEXT NOT NULL,
            precio REAL NOT NULL,
            iva TEXT NOT NULL,
            stock INTEGER NOT NULL
        )",
        [],
    )?;

    // Evita códigos/SKU duplicados. Si la base ya tenía duplicados de antes (p. ej. por el bug de
    // guardado corregido previamente), la creación del índice falla y simplemente no se aplica la
    // restricción; no queremos impedir que la app arranque por datos de prueba viejos.
    let _ = conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_productos_codigo ON productos (codigo)",
        [],
    );

    conn.execute(
        "CREATE TABLE IF NOT EXISTS categorias (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL UNIQUE
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS movimientos_stock (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            producto_id INTEGER NOT NULL,
            tipo TEXT NOT NULL,
            cantidad INTEGER NOT NULL,
            stock_resultante INTEGER NOT NULL,
            fecha TEXT NOT NULL,
            FOREIGN KEY (producto_id) REFERENCES productos (id)
        )",
        [],
    )?;

    // Cabecera de cada venta. Los importes se calculan en centavos y se guardan ya redondeados a
    // 2 decimales.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ventas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha TEXT NOT NULL,
            subtotal_cero REAL NOT NULL,
            subtotal_iva5 REAL NOT NULL,
            subtotal_iva15 REAL NOT NULL,
            iva5 REAL NOT NULL,
            iva15 REAL NOT NULL,
            total REAL NOT NULL,
            pago REAL NOT NULL,
            cambio REAL NOT NULL
        )",
        [],
    )?;

    // Líneas de cada venta. Se guarda una copia de código/detalle/precio/IVA del momento de la venta,
    // para que el historial no cambie si luego se edita o elimina el producto del catálogo.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS venta_detalle (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            venta_id INTEGER NOT NULL,
            producto_id INTEGER NOT NULL,
            codigo TEXT NOT NULL,
            detalle TEXT NOT NULL,
            cantidad INTEGER NOT NULL,
            precio_unitario REAL NOT NULL,
            iva TEXT NOT NULL,
            subtotal REAL NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_venta_detalle_venta ON venta_detalle (venta_id)",
        [],
    )?;

    // Ajustes de la app como pares clave/valor (p. ej. usar_medida = "1").
    conn.execute(
        "CREATE TABLE IF NOT EXISTS configuracion (
            clave TEXT PRIMARY KEY,
            valor TEXT NOT NULL
        )",
        [],
    )?;

    // Columnas agregadas después de la primera versión: se crean si la base es anterior.
    asegurar_columna(&conn, "productos", "medida", "TEXT NOT NULL DEFAULT ''")?;
    asegurar_columna(&conn, "venta_detalle", "medida", "TEXT NOT NULL DEFAULT ''")?;
    asegurar_columna(&conn, "productos", "aplicacion", "TEXT NOT NULL DEFAULT ''")?;
    asegurar_columna(&conn, "ventas", "descuento", "REAL NOT NULL DEFAULT 0")?;
    asegurar_columna(&conn, "venta_detalle", "precio_lista", "REAL NOT NULL DEFAULT 0")?;
    asegurar_columna(&conn, "venta_detalle", "descuento_pct", "REAL NOT NULL DEFAULT 0")?;
    asegurar_columna(&conn, "venta_detalle", "descuento", "REAL NOT NULL DEFAULT 0")?;

    // Clientes. La venta guarda el id y una copia del nombre (para que el historial no cambie si se
    // edita o elimina el cliente). Sin cliente = consumidor final.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS clientes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo_identificacion TEXT NOT NULL,
            identificacion TEXT NOT NULL UNIQUE,
            nombre TEXT NOT NULL,
            telefono TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            direccion TEXT NOT NULL DEFAULT '',
            fecha_registro TEXT NOT NULL
        )",
        [],
    )?;
    asegurar_columna(&conn, "ventas", "cliente_id", "INTEGER")?;
    asegurar_columna(&conn, "ventas", "cliente_nombre", "TEXT NOT NULL DEFAULT ''")?;
    asegurar_columna(&conn, "ventas", "cliente_identificacion", "TEXT NOT NULL DEFAULT ''")?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas (cliente_id)", [])?;

    // Devoluciones. Nunca se modifica ni se borra la venta original: cada devolución es un documento
    // aparte ligado a la venta, con copia de los importes devueltos. `reembolso` indica cómo se
    // devolvió el dinero: EFECTIVO (se entregó al cliente) o CAMBIO (queda como crédito para una
    // venta nueva, que se enlaza con ventas.devolucion_id).
    conn.execute(
        "CREATE TABLE IF NOT EXISTS devoluciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            venta_id INTEGER NOT NULL,
            fecha TEXT NOT NULL,
            motivo TEXT NOT NULL,
            reembolso TEXT NOT NULL,
            subtotal_cero REAL NOT NULL,
            subtotal_iva5 REAL NOT NULL,
            subtotal_iva15 REAL NOT NULL,
            iva5 REAL NOT NULL,
            iva15 REAL NOT NULL,
            total REAL NOT NULL
        )",
        [],
    )?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_devoluciones_venta ON devoluciones (venta_id)", [])?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS devolucion_detalle (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            devolucion_id INTEGER NOT NULL,
            venta_detalle_id INTEGER NOT NULL,
            producto_id INTEGER NOT NULL,
            codigo TEXT NOT NULL,
            detalle TEXT NOT NULL,
            cantidad INTEGER NOT NULL,
            precio_unitario REAL NOT NULL,
            iva TEXT NOT NULL,
            subtotal REAL NOT NULL,
            regresa_stock INTEGER NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_devolucion_detalle_dev ON devolucion_detalle (devolucion_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_devolucion_detalle_linea ON devolucion_detalle (venta_detalle_id)",
        [],
    )?;
    // Venta hecha como cambio: devolución cuyo crédito se aplicó y monto de ese crédito.
    asegurar_columna(&conn, "ventas", "devolucion_id", "INTEGER")?;
    asegurar_columna(&conn, "ventas", "credito", "REAL NOT NULL DEFAULT 0")?;
    // Un crédito por devolución solo se puede usar en una venta.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_devolucion ON ventas (devolucion_id)
         WHERE devolucion_id IS NOT NULL",
        [],
    )?;

    Ok(conn)
}

// Agrega una columna a una tabla existente solo si todavía no existe (migración simple).
// `tabla`, `columna` y `definicion` son siempre literales de este archivo, nunca datos del usuario.
fn asegurar_columna(
    conn: &Connection,
    tabla: &str,
    columna: &str,
    definicion: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", tabla))?;
    let existe = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|nombre| nombre == columna);
    if !existe {
        conn.execute(
            &format!("ALTER TABLE {} ADD COLUMN {} {}", tabla, columna, definicion),
            [],
        )?;
    }
    Ok(())
}

// Busca un archivo .db ya creado en el directorio de datos (la base de datos solo se crea una vez,
// con el nombre que el usuario eligió en el primer inicio).
fn buscar_base_existente(dir: &std::path::Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entrada| entrada.ok())
        .map(|entrada| entrada.path())
        .find(|ruta| ruta.extension().and_then(|ext| ext.to_str()) == Some("db"))
}

// Nombres que Windows reserva para dispositivos: no se pueden usar como nombre de archivo
// (ni siquiera con extensión, p. ej. "CON.db").
const NOMBRES_RESERVADOS_WINDOWS: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

// Deja solo caracteres seguros para un nombre de archivo (letras, números, espacios, '-' y '_').
// Los espacios se conservan (así "Mi Negocio" se muestra igual), pero se quitan los de los extremos
// y los repetidos se dejan en uno solo. A un nombre reservado de Windows se le agrega "_".
// Debe coincidir con limpiarNombre en src/views/configurar-base-datos.tsx
fn sanear_nombre_archivo(nombre: &str) -> String {
    let limpio = nombre
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == ' ')
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(60)
        .collect::<String>()
        .trim()
        .to_string();
    if NOMBRES_RESERVADOS_WINDOWS.contains(&limpio.to_uppercase().as_str()) {
        format!("{}_", limpio)
    } else {
        limpio
    }
}

#[cfg(test)]
mod pruebas_nombre_archivo {
    use super::sanear_nombre_archivo;

    #[test]
    fn conserva_espacios_simples() {
        assert_eq!(sanear_nombre_archivo("  Mi   Negocio  "), "Mi Negocio");
        assert_eq!(sanear_nombre_archivo("Repuestos/Pérez*"), "RepuestosPérez");
        assert_eq!(sanear_nombre_archivo("   "), "");
        assert_eq!(sanear_nombre_archivo("con"), "con_");
        assert_eq!(sanear_nombre_archivo("COM1"), "COM1_");
        assert_eq!(sanear_nombre_archivo("Consultora"), "Consultora");
    }
}

fn info_de_conexion(conn: &Connection) -> rusqlite::Result<InfoBaseDatos> {
    let ruta = conn.path().map(|p| p.to_string()).unwrap_or_default();
    let nombre = std::path::Path::new(&ruta)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "catalogo".to_string());
    let total_productos = contar_productos(conn, &None, &None, &None)?;

    Ok(InfoBaseDatos {
        nombre,
        ruta,
        total_productos,
    })
}

// Validaciones de negocio básicas, como respaldo por si el frontend llegara a enviar datos
// inválidos (el frontend ya valida esto mismo antes de invocar estos comandos).
fn validar_producto(codigo: &str, detalle: &str, precio: f64, iva: &str) -> Result<(), String> {
    if codigo.trim().is_empty() {
        return Err("El código es obligatorio.".to_string());
    }
    if detalle.trim().is_empty() {
        return Err("El detalle es obligatorio.".to_string());
    }
    if !precio.is_finite() || precio <= 0.0 {
        return Err("El precio debe ser mayor a 0.".to_string());
    }
    if !OPCIONES_IVA.contains(&iva) {
        return Err("Selecciona un tipo de IVA válido.".to_string());
    }
    Ok(())
}

// Normaliza un campo de texto opcional (sin espacios sobrantes y en mayúsculas).
// None = no se envió el campo (p. ej. porque está desactivado en Configuración).
fn limpiar_opcional(valor: Option<String>) -> Option<String> {
    valor.map(|m| m.trim().to_uppercase())
}

// Claves de ajustes de tipo encendido/apagado que se pueden guardar desde Configuración.
const AJUSTES_BOOLEANOS: [&str; 2] = ["usar_medida", "usar_aplicacion"];

fn leer_ajuste_booleano(conn: &Connection, clave: &str) -> rusqlite::Result<bool> {
    let valor: Option<String> = conn
        .query_row(
            "SELECT valor FROM configuracion WHERE clave = ?1",
            params![clave],
            |row| row.get(0),
        )
        .optional()?;
    Ok(valor.as_deref() == Some("1"))
}

fn leer_ajustes(conn: &Connection) -> rusqlite::Result<Ajustes> {
    Ok(Ajustes {
        usar_medida: leer_ajuste_booleano(conn, "usar_medida")?,
        usar_aplicacion: leer_ajuste_booleano(conn, "usar_aplicacion")?,
    })
}

#[tauri::command]
fn obtener_ajustes(state: tauri::State<'_, AppState>) -> Result<Ajustes, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    leer_ajustes(conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn guardar_ajuste(
    state: tauri::State<'_, AppState>,
    clave: String,
    activo: bool,
) -> Result<Ajustes, String> {
    if !AJUSTES_BOOLEANOS.contains(&clave.as_str()) {
        return Err("Ajuste no válido.".to_string());
    }
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    conn.execute(
        "INSERT INTO configuracion (clave, valor) VALUES (?1, ?2)
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor",
        params![clave, if activo { "1" } else { "0" }],
    )
    .map_err(|e| e.to_string())?;
    leer_ajustes(conn).map_err(|e| e.to_string())
}

// Datos del negocio (para encabezados de comprobantes, reportes, etc.). Se guardan en la tabla
// configuracion con claves "negocio_*". Debe coincidir con DatosNegocio en
// src/components/datos-negocio.tsx
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DatosNegocio {
    nombre_comercial: String,
    razon_social: String,
    ruc: String,
    direccion: String,
    telefono: String,
    email: String,
}

fn leer_ajuste_texto(conn: &Connection, clave: &str) -> rusqlite::Result<String> {
    let valor: Option<String> = conn
        .query_row(
            "SELECT valor FROM configuracion WHERE clave = ?1",
            params![clave],
            |row| row.get(0),
        )
        .optional()?;
    Ok(valor.unwrap_or_default())
}

// Ventas en curso (pestañas del punto de venta) guardadas como JSON, para recuperarlas si se cierra
// la app. El backend no interpreta el contenido: al cobrar, registrar_venta vuelve a validar todo.
const CLAVE_VENTAS_ABIERTAS: &str = "ventas_abiertas";
const MAX_BYTES_VENTAS_ABIERTAS: usize = 512 * 1024;

#[tauri::command]
fn obtener_ventas_abiertas(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    leer_ajuste_texto(conn, CLAVE_VENTAS_ABIERTAS).map_err(|e| e.to_string())
}

#[tauri::command]
fn guardar_ventas_abiertas(state: tauri::State<'_, AppState>, datos: String) -> Result<(), String> {
    if datos.len() > MAX_BYTES_VENTAS_ABIERTAS {
        return Err("Hay demasiadas ventas abiertas para guardarlas.".to_string());
    }
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    conn.execute(
        "INSERT INTO configuracion (clave, valor) VALUES (?1, ?2)
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor",
        params![CLAVE_VENTAS_ABIERTAS, datos],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn leer_datos_negocio(conn: &Connection) -> rusqlite::Result<DatosNegocio> {
    Ok(DatosNegocio {
        nombre_comercial: leer_ajuste_texto(conn, "negocio_nombre_comercial")?,
        razon_social: leer_ajuste_texto(conn, "negocio_razon_social")?,
        ruc: leer_ajuste_texto(conn, "negocio_ruc")?,
        direccion: leer_ajuste_texto(conn, "negocio_direccion")?,
        telefono: leer_ajuste_texto(conn, "negocio_telefono")?,
        email: leer_ajuste_texto(conn, "negocio_email")?,
    })
}

#[tauri::command]
fn obtener_datos_negocio(state: tauri::State<'_, AppState>) -> Result<DatosNegocio, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    leer_datos_negocio(conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn guardar_datos_negocio(
    state: tauri::State<'_, AppState>,
    datos: DatosNegocio,
) -> Result<DatosNegocio, String> {
    let datos = DatosNegocio {
        nombre_comercial: datos.nombre_comercial.trim().to_uppercase(),
        razon_social: datos.razon_social.trim().to_uppercase(),
        ruc: datos.ruc.trim().to_string(),
        direccion: datos.direccion.trim().to_uppercase(),
        telefono: datos.telefono.trim().to_string(),
        email: datos.email.trim().to_lowercase(),
    };

    if datos.nombre_comercial.chars().count() < 2 {
        return Err("El nombre del negocio es obligatorio.".to_string());
    }
    if !datos.ruc.is_empty() && (datos.ruc.len() != 13 || !datos.ruc.chars().all(|c| c.is_ascii_digit())) {
        return Err("El RUC debe tener 13 dígitos.".to_string());
    }
    if !datos.email.is_empty() && !(datos.email.contains('@') && datos.email.contains('.')) {
        return Err("El email no es válido.".to_string());
    }

    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (clave, valor) in [
        ("negocio_nombre_comercial", &datos.nombre_comercial),
        ("negocio_razon_social", &datos.razon_social),
        ("negocio_ruc", &datos.ruc),
        ("negocio_direccion", &datos.direccion),
        ("negocio_telefono", &datos.telefono),
        ("negocio_email", &datos.email),
    ] {
        tx.execute(
            "INSERT INTO configuracion (clave, valor) VALUES (?1, ?2)
             ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor",
            params![clave, valor],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    leer_datos_negocio(conn).map_err(|e| e.to_string())
}

// El precio se maneja siempre con 2 decimales (centavos).
fn redondear_precio(precio: f64) -> f64 {
    (precio * 100.0).round() / 100.0
}

// true si el error es por violar una restricción UNIQUE (p. ej. código o nombre duplicado).
fn es_duplicado(err: &rusqlite::Error) -> bool {
    matches!(err, rusqlite::Error::SqliteFailure(_, Some(mensaje)) if mensaje.contains("UNIQUE"))
}

// Traduce errores de SQLite a mensajes entendibles por el usuario (p. ej. código duplicado).
fn mapear_error_guardado(err: rusqlite::Error) -> String {
    if es_duplicado(&err) {
        return "Ya existe un producto con ese código.".to_string();
    }
    err.to_string()
}

// ---------------------------------------------------------------------------------------------
// Búsqueda por palabras sueltas
// ---------------------------------------------------------------------------------------------

// Nombres de parámetro para cada palabra buscada (máximo MAX_PALABRAS_BUSQUEDA palabras).
const PARAMS_PALABRAS: [&str; 8] = [":w0", ":w1", ":w2", ":w3", ":w4", ":w5", ":w6", ":w7"];
const MAX_PALABRAS_BUSQUEDA: usize = PARAMS_PALABRAS.len();

// Texto donde se buscan las palabras de un producto: todos los campos juntos.
const TEXTO_PRODUCTO: &str = "codigo || ' ' || detalle || ' ' || medida || ' ' || aplicacion || ' ' || categoria";
const TEXTO_CLIENTE: &str = "c.nombre || ' ' || c.identificacion || ' ' || c.telefono";

// Pasa a mayúsculas y quita tildes (la Ñ se conserva), para que "valvula" encuentre "VÁLVULA".
fn normalizar_busqueda(texto: &str) -> String {
    texto
        .to_uppercase()
        .chars()
        .map(|c| match c {
            'Á' | 'À' | 'Ä' | 'Â' => 'A',
            'É' | 'È' | 'Ë' | 'Ê' => 'E',
            'Í' | 'Ì' | 'Ï' | 'Î' => 'I',
            'Ó' | 'Ò' | 'Ö' | 'Ô' => 'O',
            'Ú' | 'Ù' | 'Ü' | 'Û' => 'U',
            otro => otro,
        })
        .collect()
}

// Equivalente en SQL de normalizar_busqueda para una expresión de columnas.
fn sql_normalizado(expr: &str) -> String {
    let mut sql = format!("UPPER({})", expr);
    for (con, sin) in [("Á", "A"), ("É", "E"), ("Í", "I"), ("Ó", "O"), ("Ú", "U"), ("Ü", "U")] {
        sql = format!("REPLACE({}, '{}', '{}')", sql, con, sin);
    }
    sql
}

// Condición SQL donde cada palabra del texto debe aparecer (en cualquier orden y en cualquier campo)
// dentro de `expr`. Ej.: "rodam aveo" encuentra "RODAMIENTO RUEDA ... CHEVROLET AVEO".
// Devuelve None si no hay palabras. `expr` es siempre un literal de este archivo.
fn condicion_palabras(texto: &str, expr: &str) -> Option<(String, Vec<(&'static str, Value)>)> {
    let normal = normalizar_busqueda(texto);
    let palabras: Vec<&str> = normal.split_whitespace().take(MAX_PALABRAS_BUSQUEDA).collect();
    if palabras.is_empty() {
        return None;
    }
    let columna = sql_normalizado(expr);
    let mut condiciones = Vec::new();
    let mut valores = Vec::new();
    for (palabra, nombre) in palabras.iter().zip(PARAMS_PALABRAS) {
        // Se escapan los comodines de LIKE para que % y _ se busquen literalmente.
        let escapada = palabra.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        condiciones.push(format!("{} LIKE {} ESCAPE '\\'", columna, nombre));
        valores.push((nombre, Value::Text(format!("%{}%", escapada))));
    }
    Some((format!("({})", condiciones.join(" AND ")), valores))
}

fn como_parametros<'a>(valores: &'a [(&'static str, Value)]) -> Vec<(&'static str, &'a dyn ToSql)> {
    valores.iter().map(|(k, v)| (*k, v as &dyn ToSql)).collect()
}

#[cfg(test)]
mod pruebas_busqueda {
    use super::*;

    fn buscar(conn: &Connection, texto: &str) -> Vec<String> {
        let (clausula, valores) = construir_filtro(&Some(texto.to_string()), &None, &None);
        let mut stmt = conn
            .prepare(&format!("SELECT detalle FROM productos {} ORDER BY id", clausula))
            .unwrap();
        stmt.query_map(&como_parametros(&valores)[..], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap()
    }

    #[test]
    fn busca_palabras_en_cualquier_orden_y_sin_tildes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE productos (id INTEGER PRIMARY KEY, codigo TEXT, detalle TEXT, categoria TEXT,
                                     medida TEXT, aplicacion TEXT, stock INTEGER);
             INSERT INTO productos VALUES
               (1, 'R-100', 'RODAMIENTO RUEDA DELANTERA', 'RODAMIENTOS', '6203-2RS', 'CHEVROLET AVEO 2008', 5),
               (2, 'V-200', 'VÁLVULA DE ADMISIÓN', 'MOTOR', '', 'SUZUKI FORSA', 5),
               (3, 'R-300', 'RODAMIENTO TRASERO', 'RODAMIENTOS', '6204', 'HYUNDAI ACCENT', 5),
               (4, 'X_1', 'PRODUCTO 100%', 'VARIOS', '', '', 5);",
        )
        .unwrap();

        assert_eq!(buscar(&conn, "aveo rodam"), vec!["RODAMIENTO RUEDA DELANTERA"]);
        assert_eq!(buscar(&conn, "valvula admision"), vec!["VÁLVULA DE ADMISIÓN"]);
        assert_eq!(buscar(&conn, "  rodamiento  "), vec!["RODAMIENTO RUEDA DELANTERA", "RODAMIENTO TRASERO"]);
        assert_eq!(buscar(&conn, "6203 delantera"), vec!["RODAMIENTO RUEDA DELANTERA"]);
        assert!(buscar(&conn, "rodamiento suzuki").is_empty());
        // Los comodines de LIKE se buscan literalmente
        assert_eq!(buscar(&conn, "100%"), vec!["PRODUCTO 100%"]);
        assert_eq!(buscar(&conn, "x_"), vec!["PRODUCTO 100%"]);
    }
}

// Construye la cláusula WHERE y los valores con nombre según los filtros activos (búsqueda por
// palabras sueltas en todos los campos y categoría exacta). Si no hay filtros, la cláusula queda vacía.
fn construir_filtro(
    busqueda: &Option<String>,
    categoria: &Option<String>,
    estado_stock: &Option<String>,
) -> (String, Vec<(&'static str, Value)>) {
    let mut condiciones = Vec::new();
    let mut valores: Vec<(&'static str, Value)> = Vec::new();

    if let Some((condicion, palabras)) = busqueda.as_deref().and_then(|t| condicion_palabras(t, TEXTO_PRODUCTO)) {
        condiciones.push(condicion);
        valores.extend(palabras);
    }

    if let Some(cat) = categoria.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        condiciones.push("categoria = :categoria".to_string());
        valores.push((":categoria", Value::Text(cat.to_uppercase())));
    }

    // Filtro por estado del stock (solo Inventario). Valores desconocidos se ignoran.
    match estado_stock.as_deref() {
        Some("SIN_STOCK") => condiciones.push("stock <= 0".to_string()),
        Some("BAJO") => {
            condiciones.push("stock > 0 AND stock <= :umbral_bajo".to_string());
            valores.push((":umbral_bajo", Value::Integer(UMBRAL_STOCK_BAJO as i64)));
        }
        Some("CON_STOCK") => condiciones.push("stock > 0".to_string()),
        Some("OK") => {
            condiciones.push("stock > :umbral_bajo".to_string());
            valores.push((":umbral_bajo", Value::Integer(UMBRAL_STOCK_BAJO as i64)));
        }
        _ => {}
    }

    let clausula = if condiciones.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", condiciones.join(" AND "))
    };

    (clausula, valores)
}

fn contar_productos(
    conn: &Connection,
    busqueda: &Option<String>,
    categoria: &Option<String>,
    estado_stock: &Option<String>,
) -> rusqlite::Result<i64> {
    let (clausula, valores) = construir_filtro(busqueda, categoria, estado_stock);
    let sql = format!("SELECT COUNT(*) FROM productos {}", clausula);
    conn.query_row(&sql, &como_parametros(&valores)[..], |row| row.get(0))
}

// Columnas de un producto en el orden que espera mapear_producto.
const COLUMNAS_PRODUCTO: &str = "id, codigo, detalle, categoria, precio, iva, stock, medida, aplicacion";

fn mapear_producto(row: &rusqlite::Row) -> rusqlite::Result<Producto> {
    Ok(Producto {
        id: row.get(0)?,
        codigo: row.get(1)?,
        detalle: row.get(2)?,
        categoria: row.get(3)?,
        precio: row.get(4)?,
        iva: row.get(5)?,
        stock: row.get(6)?,
        medida: row.get(7)?,
        aplicacion: row.get(8)?,
    })
}

// Devuelve siempre una página válida (ajustada al rango existente) junto con el total de productos
// que cumplen los filtros, para no tener que cargar la tabla completa en el frontend.
// `orden_por` es siempre un literal fijo definido en este archivo (no viene del usuario), así que es
// seguro interpolarlo directamente en el SQL.
fn listar_pagina(
    conn: &Connection,
    pagina_solicitada: i64,
    busqueda: &Option<String>,
    categoria: &Option<String>,
    estado_stock: &Option<String>,
    orden_por: &str,
) -> rusqlite::Result<PaginaProductos> {
    let total = contar_productos(conn, busqueda, categoria, estado_stock)?;
    let total_paginas = ((total as f64) / (PRODUCTOS_POR_PAGINA as f64)).ceil().max(1.0) as i64;
    let pagina = pagina_solicitada.clamp(1, total_paginas);
    let offset = (pagina - 1) * PRODUCTOS_POR_PAGINA;

    let (clausula, mut valores) = construir_filtro(busqueda, categoria, estado_stock);
    valores.push((":limite", Value::Integer(PRODUCTOS_POR_PAGINA)));
    valores.push((":offset", Value::Integer(offset)));

    let sql = format!(
        "SELECT {} FROM productos {} ORDER BY {} LIMIT :limite OFFSET :offset",
        COLUMNAS_PRODUCTO, clausula, orden_por
    );

    let mut stmt = conn.prepare(&sql)?;
    let productos = stmt
        .query_map(&como_parametros(&valores)[..], mapear_producto)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(PaginaProductos {
        productos,
        total,
        pagina,
    })
}

// Las operaciones sobre productos requieren que ya exista una base de datos configurada.
fn requerir_conexion(
    conn_opt: &Option<Connection>,
) -> Result<&Connection, String> {
    conn_opt
        .as_ref()
        .ok_or_else(|| "La base de datos no está configurada.".to_string())
}

#[tauri::command]
fn obtener_configuracion_db(
    state: tauri::State<'_, AppState>,
) -> Result<Option<InfoBaseDatos>, String> {
    let conn_guard = state.db.lock().unwrap();
    match conn_guard.as_ref() {
        None => Ok(None),
        Some(conn) => info_de_conexion(conn).map(Some).map_err(|e| e.to_string()),
    }
}

// Palabra que hay que escribir para confirmar el borrado. Debe coincidir con
// PALABRA_CONFIRMACION en src/views/configuracion.tsx
const PALABRA_CONFIRMACION: &str = "CONFIRMAR";

// Borra por completo la base de datos (productos, inventario, ventas, clientes y ajustes).
// Cierra la conexión, elimina el archivo .db y sus archivos auxiliares de SQLite, y deja la app
// sin base configurada para que se cree una nueva desde la pantalla de primer inicio.
#[tauri::command]
fn eliminar_base_de_datos(state: tauri::State<'_, AppState>, confirmacion: String) -> Result<(), String> {
    if confirmacion.trim() != PALABRA_CONFIRMACION {
        return Err(format!("Escribe {} para eliminar la base de datos.", PALABRA_CONFIRMACION));
    }

    let mut conn_guard = state.db.lock().unwrap();
    let conn = conn_guard
        .take()
        .ok_or_else(|| "La base de datos no está configurada.".to_string())?;
    let ruta = conn.path().map(|p| p.to_string()).unwrap_or_default();

    // En Windows el archivo no se puede borrar mientras la conexión esté abierta.
    if let Err((conn, e)) = conn.close() {
        *conn_guard = Some(conn);
        return Err(format!("No se pudo cerrar la base de datos: {}", e));
    }

    if ruta.is_empty() {
        return Err("No se encontró el archivo de la base de datos.".to_string());
    }
    std::fs::remove_file(&ruta).map_err(|e| format!("No se pudo eliminar el archivo: {}", e))?;
    for sufijo in ["-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{}{}", ruta, sufijo));
    }
    Ok(())
}

#[tauri::command]
fn crear_base_de_datos(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    nombre: String,
) -> Result<InfoBaseDatos, String> {
    let mut conn_guard = state.db.lock().unwrap();
    if conn_guard.is_some() {
        return Err("Ya existe una base de datos configurada.".to_string());
    }

    let nombre_limpio = sanear_nombre_archivo(&nombre);
    if nombre_limpio.is_empty() {
        return Err("Ingresa un nombre válido para la base de datos.".to_string());
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let ruta = dir.join(format!("{}.db", nombre_limpio));
    let conn = abrir_base_de_datos(ruta).map_err(|e| e.to_string())?;
    let info = info_de_conexion(&conn).map_err(|e| e.to_string());
    *conn_guard = Some(conn);
    info
}

// ---------------------------------------------------------------------------------------------
// Copias de seguridad
// ---------------------------------------------------------------------------------------------

// Las copias se guardan en una subcarpeta del directorio de datos. Va en una subcarpeta para que
// buscar_base_existente (que solo mira el directorio raíz) no confunda una copia con la base activa.
const CARPETA_COPIAS: &str = "copias";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CopiaSeguridad {
    // Nombre del archivo (identifica la copia al restaurar o eliminar)
    archivo: String,
    // Fecha legible "YYYY-MM-DD HH:MM:SS", sacada del nombre del archivo
    fecha: String,
    // true si se creó automáticamente antes de restaurar otra copia
    automatica: bool,
    tamano_bytes: u64,
}

fn directorio_copias(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(CARPETA_COPIAS);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// Crea una copia consistente de la base con VACUUM INTO (funciona con la conexión abierta).
// El nombre empieza con la fecha para que se ordenen solas: "2026-11-07_15-30-00_manual.db".
fn crear_copia(conn: &Connection, dir: &std::path::Path, tipo: &str) -> Result<PathBuf, String> {
    let fecha: String = conn
        .query_row("SELECT strftime('%Y-%m-%d_%H-%M-%S', 'now', 'localtime')", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let mut destino = dir.join(format!("{}_{}.db", fecha, tipo));
    // Dos copias en el mismo segundo: se agrega un número (VACUUM INTO exige que el archivo no exista)
    let mut n = 2;
    while destino.exists() {
        destino = dir.join(format!("{}_{}-{}.db", fecha, tipo, n));
        n += 1;
    }
    conn.execute("VACUUM INTO ?1", params![destino.to_string_lossy()])
        .map_err(|e| format!("No se pudo crear la copia de seguridad: {}", e))?;
    Ok(destino)
}

// Solo acepta un nombre de archivo .db que exista dentro de la carpeta de copias (sin rutas),
// para que el frontend no pueda apuntar a archivos fuera de ella.
fn ruta_copia(dir: &std::path::Path, archivo: &str) -> Result<PathBuf, String> {
    let valido = !archivo.is_empty()
        && !archivo.contains(['/', '\\', ':'])
        && !archivo.contains("..")
        && archivo.ends_with(".db");
    let ruta = dir.join(archivo);
    if !valido || !ruta.is_file() {
        return Err("No se encontró la copia de seguridad.".to_string());
    }
    Ok(ruta)
}

fn listar_copias(dir: &std::path::Path) -> Result<Vec<CopiaSeguridad>, String> {
    let mut copias: Vec<CopiaSeguridad> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entrada| entrada.ok())
        .filter_map(|entrada| {
            let ruta = entrada.path();
            if ruta.extension().and_then(|e| e.to_str()) != Some("db") {
                return None;
            }
            let archivo = ruta.file_name()?.to_string_lossy().to_string();
            // "2026-11-07_15-30-00..." -> "2026-11-07 15:30:00"
            let fecha = archivo
                .get(0..19)
                .filter(|f| f.is_char_boundary(10) && f.is_char_boundary(11))
                .map(|f| format!("{} {}", &f[0..10], f[11..].replace('-', ":")))
                .unwrap_or_else(|| archivo.clone());
            Some(CopiaSeguridad {
                automatica: archivo.contains("_antes-de-restaurar"),
                tamano_bytes: entrada.metadata().map(|m| m.len()).unwrap_or(0),
                archivo,
                fecha,
            })
        })
        .collect();
    copias.sort_by(|a, b| b.archivo.cmp(&a.archivo));
    Ok(copias)
}

#[cfg(test)]
mod pruebas_copias {
    use super::*;

    #[test]
    fn crea_y_lista_copias() {
        let dir = std::env::temp_dir().join(format!("copias-prueba-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let conn = abrir_base_de_datos(dir.join("base.db")).unwrap();
        let copia = crear_copia(&conn, &dir, "manual").unwrap();
        crear_copia(&conn, &dir, "antes-de-restaurar").unwrap();

        // La copia es una base válida con la tabla de productos
        let prueba = Connection::open(&copia).unwrap();
        let tablas: i64 = prueba
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'productos'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tablas, 1);

        let copias = listar_copias(&dir).unwrap();
        // base.db también está en este directorio de prueba, se excluye por el nombre
        let copias: Vec<_> = copias.into_iter().filter(|c| c.archivo != "base.db").collect();
        assert_eq!(copias.len(), 2);
        assert!(copias.iter().any(|c| c.automatica));
        assert_eq!(copias[0].fecha.len(), 19);

        // No acepta rutas fuera de la carpeta
        assert!(ruta_copia(&dir, "../otra.db").is_err());
        assert!(ruta_copia(&dir, &copias[0].archivo).is_ok());

        drop(prueba);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[tauri::command]
fn obtener_copias_seguridad(app: tauri::AppHandle) -> Result<Vec<CopiaSeguridad>, String> {
    listar_copias(&directorio_copias(&app)?)
}

#[tauri::command]
fn crear_copia_seguridad(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CopiaSeguridad>, String> {
    let dir = directorio_copias(&app)?;
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    crear_copia(conn, &dir, "manual")?;
    listar_copias(&dir)
}

#[tauri::command]
fn eliminar_copia_seguridad(app: tauri::AppHandle, archivo: String) -> Result<Vec<CopiaSeguridad>, String> {
    let dir = directorio_copias(&app)?;
    let ruta = ruta_copia(&dir, &archivo)?;
    std::fs::remove_file(ruta).map_err(|e| format!("No se pudo eliminar la copia: {}", e))?;
    listar_copias(&dir)
}

// Reemplaza la base activa por una copia. Antes guarda una copia automática del estado actual,
// así un restaurado por error se puede deshacer restaurando esa copia.
#[tauri::command]
fn restaurar_copia_seguridad(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    archivo: String,
) -> Result<InfoBaseDatos, String> {
    let dir = directorio_copias(&app)?;
    let origen = ruta_copia(&dir, &archivo)?;

    // Verifica que la copia sea una base válida de esta app antes de tocar nada.
    {
        let invalida = || "El archivo no es una copia válida.".to_string();
        let prueba = Connection::open_with_flags(&origen, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| invalida())?;
        let tablas: i64 = prueba
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'productos'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| invalida())?;
        if tablas == 0 {
            return Err(invalida());
        }
    }

    let mut conn_guard = state.db.lock().unwrap();
    let conn = conn_guard
        .take()
        .ok_or_else(|| "La base de datos no está configurada.".to_string())?;
    let ruta_actual = PathBuf::from(conn.path().map(|p| p.to_string()).unwrap_or_default());

    let respaldo = match crear_copia(&conn, &dir, "antes-de-restaurar") {
        Ok(r) => r,
        Err(e) => {
            *conn_guard = Some(conn);
            return Err(e);
        }
    };

    // En Windows el archivo no se puede reemplazar mientras la conexión esté abierta.
    if let Err((conn, e)) = conn.close() {
        *conn_guard = Some(conn);
        return Err(format!("No se pudo cerrar la base de datos: {}", e));
    }
    for sufijo in ["-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{}{}", ruta_actual.display(), sufijo));
    }

    // Copia y reabre; si algo falla, vuelve a dejar la base como estaba.
    let resultado = std::fs::copy(&origen, &ruta_actual)
        .map_err(|e| format!("No se pudo restaurar la copia: {}", e))
        .and_then(|_| abrir_base_de_datos(ruta_actual.clone()).map_err(|e| e.to_string()));

    let conn = match resultado {
        Ok(conn) => conn,
        Err(e) => {
            let _ = std::fs::copy(&respaldo, &ruta_actual);
            if let Ok(conn) = abrir_base_de_datos(ruta_actual.clone()) {
                *conn_guard = Some(conn);
            }
            return Err(e);
        }
    };

    // La conexión se guarda antes de leer la info: si eso fallara, la app no debe quedar sin base.
    let info = info_de_conexion(&conn).map_err(|e| e.to_string());
    *conn_guard = Some(conn);
    info
}

#[tauri::command]
fn abrir_carpeta_copias(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = directorio_copias(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn listar_categorias(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT nombre FROM categorias ORDER BY nombre")?;
    stmt.query_map([], |row| row.get(0))?.collect()
}

#[tauri::command]
fn obtener_categorias(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    listar_categorias(conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn agregar_categoria(
    state: tauri::State<'_, AppState>,
    nombre: String,
) -> Result<Vec<String>, String> {
    let nombre = nombre.trim().to_uppercase();
    if nombre.is_empty() {
        return Err("Escribe un nombre de categoría.".to_string());
    }

    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    conn.execute("INSERT INTO categorias (nombre) VALUES (?1)", params![nombre])
        .map_err(|e| {
            if es_duplicado(&e) {
                "Esa categoría ya existe.".to_string()
            } else {
                e.to_string()
            }
        })?;

    listar_categorias(conn).map_err(|e| e.to_string())
}

// Renombra una categoría y actualiza todos los productos que la usaban (los productos guardan el
// nombre como texto), en una sola transacción para que no queden datos a medias.
#[tauri::command]
fn renombrar_categoria(
    state: tauri::State<'_, AppState>,
    nombre_actual: String,
    nombre_nuevo: String,
) -> Result<Vec<String>, String> {
    let nombre_actual = nombre_actual.trim().to_uppercase();
    let nombre_nuevo = nombre_nuevo.trim().to_uppercase();
    if nombre_nuevo.is_empty() {
        return Err("Escribe un nombre de categoría.".to_string());
    }

    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    if nombre_actual == nombre_nuevo {
        return listar_categorias(conn).map_err(|e| e.to_string());
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let filas = tx
        .execute(
            "UPDATE categorias SET nombre = ?1 WHERE nombre = ?2",
            params![nombre_nuevo, nombre_actual],
        )
        .map_err(|e| {
            if es_duplicado(&e) {
                "Ya existe una categoría con ese nombre.".to_string()
            } else {
                e.to_string()
            }
        })?;
    if filas == 0 {
        return Err("La categoría no existe.".to_string());
    }
    tx.execute(
        "UPDATE productos SET categoria = ?1 WHERE categoria = ?2",
        params![nombre_nuevo, nombre_actual],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    listar_categorias(conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn eliminar_categoria(
    state: tauri::State<'_, AppState>,
    nombre: String,
) -> Result<Vec<String>, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    // Los productos guardan el nombre de la categoría como texto: si se borrara una en uso, esos
    // productos quedarían con una categoría que ya no aparece en los filtros ni en el formulario.
    let en_uso: i64 = conn
        .query_row("SELECT COUNT(*) FROM productos WHERE categoria = ?1", params![nombre], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if en_uso > 0 {
        return Err(format!(
            "No se puede eliminar {}: la usa{} {} producto{}. Cámbiales la categoría o renómbrala.",
            nombre,
            if en_uso == 1 { "" } else { "n" },
            en_uso,
            if en_uso == 1 { "" } else { "s" }
        ));
    }
    conn.execute("DELETE FROM categorias WHERE nombre = ?1", params![nombre])
        .map_err(|e| e.to_string())?;

    listar_categorias(conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn obtener_productos(
    state: tauri::State<'_, AppState>,
    pagina: i64,
    busqueda: Option<String>,
    categoria_filtro: Option<String>,
) -> Result<PaginaProductos, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    listar_pagina(conn, pagina, &busqueda, &categoria_filtro, &None, "id DESC").map_err(|e| e.to_string())
}

// Vista de solo lectura para Inventario: mismo listado paginado/filtrado, pero ordenado por menor
// stock primero, para detectar rápido qué está bajo o sin stock.
#[tauri::command]
fn obtener_inventario(
    state: tauri::State<'_, AppState>,
    pagina: i64,
    busqueda: Option<String>,
    categoria_filtro: Option<String>,
    estado_stock: Option<String>,
) -> Result<PaginaProductos, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    listar_pagina(conn, pagina, &busqueda, &categoria_filtro, &estado_stock, "stock ASC, id DESC")
        .map_err(|e| e.to_string())
}

fn obtener_stock_actual(conn: &Connection, id: i64) -> rusqlite::Result<i32> {
    conn.query_row("SELECT stock FROM productos WHERE id = ?1", params![id], |row| row.get(0))
}

// Deja constancia del movimiento (entrada o salida) en el historial de stock del producto.
fn registrar_movimiento(
    conn: &Connection,
    producto_id: i64,
    tipo: &str,
    cantidad: i32,
    stock_resultante: i32,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO movimientos_stock (producto_id, tipo, cantidad, stock_resultante, fecha)
         VALUES (?1, ?2, ?3, ?4, datetime('now', 'localtime'))",
        params![producto_id, tipo, cantidad, stock_resultante],
    )?;
    Ok(())
}

// Suma stock a un producto existente (p. ej. al recibir mercadería), sin pasar por el formulario
// completo de edición.
#[tauri::command]
fn agregar_stock(
    state: tauri::State<'_, AppState>,
    id: i64,
    cantidad: i32,
    pagina: i64,
    busqueda: Option<String>,
    categoria_filtro: Option<String>,
    estado_stock: Option<String>,
) -> Result<PaginaProductos, String> {
    if cantidad <= 0 {
        return Err("La cantidad a agregar debe ser mayor a 0.".to_string());
    }

    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    // Stock y movimiento juntos: o se guardan los dos o ninguno.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let stock_actual = obtener_stock_actual(&tx, id)
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "El producto ya no existe.".to_string())?;
    let stock_resultante = stock_actual
        .checked_add(cantidad)
        .ok_or_else(|| "La cantidad es demasiado grande.".to_string())?;
    tx.execute(
        "UPDATE productos SET stock = ?1 WHERE id = ?2",
        params![stock_resultante, id],
    )
    .map_err(|e| e.to_string())?;
    registrar_movimiento(&tx, id, "ENTRADA", cantidad, stock_resultante).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    listar_pagina(conn, pagina, &busqueda, &categoria_filtro, &estado_stock, "stock ASC, id DESC")
        .map_err(|e| e.to_string())
}

// Resta stock de un producto existente (p. ej. una venta o un ajuste). No permite bajar de 0.
#[tauri::command]
fn quitar_stock(
    state: tauri::State<'_, AppState>,
    id: i64,
    cantidad: i32,
    pagina: i64,
    busqueda: Option<String>,
    categoria_filtro: Option<String>,
    estado_stock: Option<String>,
) -> Result<PaginaProductos, String> {
    if cantidad <= 0 {
        return Err("La cantidad a quitar debe ser mayor a 0.".to_string());
    }

    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let stock_actual = obtener_stock_actual(&tx, id)
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "El producto ya no existe.".to_string())?;
    if cantidad > stock_actual {
        return Err(format!("No hay suficiente stock (disponible: {}).", stock_actual));
    }

    let stock_resultante = stock_actual - cantidad;
    tx.execute(
        "UPDATE productos SET stock = ?1 WHERE id = ?2",
        params![stock_resultante, id],
    )
    .map_err(|e| e.to_string())?;
    registrar_movimiento(&tx, id, "SALIDA", cantidad, stock_resultante).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    listar_pagina(conn, pagina, &busqueda, &categoria_filtro, &estado_stock, "stock ASC, id DESC")
        .map_err(|e| e.to_string())
}

// Historial de movimientos de un producto, más recientes primero.
#[tauri::command]
fn obtener_movimientos(
    state: tauri::State<'_, AppState>,
    producto_id: i64,
) -> Result<Vec<Movimiento>, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, tipo, cantidad, stock_resultante, fecha
             FROM movimientos_stock WHERE producto_id = ?1 ORDER BY id DESC",
        )
        .map_err(|e| e.to_string())?;

    stmt.query_map(params![producto_id], |row| {
        Ok(Movimiento {
            id: row.get(0)?,
            tipo: row.get(1)?,
            cantidad: row.get(2)?,
            stock_resultante: row.get(3)?,
            fecha: row.get(4)?,
        })
    })
    .map_err(|e| e.to_string())?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn agregar_producto(
    state: tauri::State<'_, AppState>,
    codigo: String,
    detalle: String,
    categoria: String,
    precio: f64,
    iva: String,
    medida: Option<String>,
    aplicacion: Option<String>,
    busqueda: Option<String>,
    categoria_filtro: Option<String>,
) -> Result<PaginaProductos, String> {
    let precio = redondear_precio(precio);
    validar_producto(&codigo, &detalle, precio, &iva)?;
    let medida = limpiar_opcional(medida).unwrap_or_default();
    let aplicacion = limpiar_opcional(aplicacion).unwrap_or_default();

    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    // El stock inicial siempre es 0: se gestiona exclusivamente desde Inventario.
    conn.execute(
        "INSERT INTO productos (codigo, detalle, categoria, precio, iva, stock, medida, aplicacion)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
        params![codigo, detalle, categoria, precio, iva, medida, aplicacion],
    )
    .map_err(mapear_error_guardado)?;

    // El producto nuevo queda primero (orden por id descendente), así que mostramos la página 1
    // respetando los filtros que el usuario tenga activos.
    listar_pagina(conn, 1, &busqueda, &categoria_filtro, &None, "id DESC").map_err(|e| e.to_string())
}

#[tauri::command]
fn actualizar_producto(
    state: tauri::State<'_, AppState>,
    id: i64,
    pagina: i64,
    codigo: String,
    detalle: String,
    categoria: String,
    precio: f64,
    iva: String,
    medida: Option<String>,
    aplicacion: Option<String>,
    busqueda: Option<String>,
    categoria_filtro: Option<String>,
) -> Result<PaginaProductos, String> {
    let precio = redondear_precio(precio);
    validar_producto(&codigo, &detalle, precio, &iva)?;
    // Si no se envía medida (campo desactivado en Configuración) se conserva la que ya tenía.
    let medida = limpiar_opcional(medida);
    let aplicacion = limpiar_opcional(aplicacion);

    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    // El stock no se toca aquí: se gestiona exclusivamente desde Inventario.
    conn.execute(
        "UPDATE productos SET codigo = ?1, detalle = ?2, categoria = ?3, precio = ?4, iva = ?5,
                medida = COALESCE(?7, medida), aplicacion = COALESCE(?8, aplicacion)
         WHERE id = ?6",
        params![codigo, detalle, categoria, precio, iva, id, medida, aplicacion],
    )
    .map_err(mapear_error_guardado)?;

    listar_pagina(conn, pagina, &busqueda, &categoria_filtro, &None, "id DESC").map_err(|e| e.to_string())
}

#[tauri::command]
fn eliminar_producto(
    state: tauri::State<'_, AppState>,
    id: i64,
    pagina: i64,
    busqueda: Option<String>,
    categoria_filtro: Option<String>,
) -> Result<PaginaProductos, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM movimientos_stock WHERE producto_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM productos WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    listar_pagina(conn, pagina, &busqueda, &categoria_filtro, &None, "id DESC").map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------
// Ventas
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemVenta {
    producto_id: i64,
    cantidad: i32,
    // Precio unitario cobrado (puede diferir del precio de lista del catálogo).
    precio: f64,
    // Descuento de la línea en dólares (sobre precio × cantidad).
    #[serde(default)]
    descuento: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Venta {
    id: i64,
    fecha: String,
    subtotal_cero: f64,
    subtotal_iva5: f64,
    subtotal_iva15: f64,
    iva5: f64,
    iva15: f64,
    total: f64,
    pago: f64,
    cambio: f64,
    unidades: i64,
    descuento: f64,
    // Vacío = consumidor final
    cliente_nombre: String,
    cliente_identificacion: String,
    // Suma de todas las devoluciones hechas sobre esta venta.
    total_devuelto: f64,
    // Crédito de una devolución (cambio) aplicado al cobrar esta venta.
    credito: f64,
    devolucion_id: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DetalleVenta {
    id: i64,
    codigo: String,
    detalle: String,
    cantidad: i32,
    precio_unitario: f64,
    iva: String,
    subtotal: f64,
    medida: String,
    precio_lista: f64,
    descuento_pct: f64,
    descuento: f64,
    // Unidades de esta línea ya devueltas en devoluciones anteriores.
    devuelto: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PaginaVentas {
    ventas: Vec<Venta>,
    total: i64,
    pagina: i64,
    ventas_hoy: i64,
    monto_hoy: f64,
}

// Todo el cálculo de dinero se hace en centavos (enteros) para evitar errores de coma flotante.
fn a_centavos(valor: f64) -> i64 {
    (valor * 100.0).round() as i64
}

fn de_centavos(centavos: i64) -> f64 {
    centavos as f64 / 100.0
}

// Porcentaje de IVA según el tipo guardado en el producto. Sin IVA y Exento tributan 0%.
fn porcentaje_iva(iva: &str) -> i64 {
    match iva {
        "IVA_15" => 15,
        "IVA_5" => 5,
        _ => 0,
    }
}

// IVA en centavos de una base en centavos, redondeado al centavo más cercano.
fn calcular_iva(base_centavos: i64, porcentaje: i64) -> i64 {
    (base_centavos * porcentaje + 50) / 100
}

const SELECT_VENTA: &str = "SELECT v.id, v.fecha, v.subtotal_cero, v.subtotal_iva5, v.subtotal_iva15,
            v.iva5, v.iva15, v.total, v.pago, v.cambio,
            (SELECT COALESCE(SUM(d.cantidad), 0) FROM venta_detalle d WHERE d.venta_id = v.id),
            v.descuento, v.cliente_nombre, v.cliente_identificacion,
            (SELECT COALESCE(SUM(dv.total), 0) FROM devoluciones dv WHERE dv.venta_id = v.id),
            v.credito, v.devolucion_id
     FROM ventas v";

fn mapear_venta(row: &rusqlite::Row) -> rusqlite::Result<Venta> {
    Ok(Venta {
        id: row.get(0)?,
        fecha: row.get(1)?,
        subtotal_cero: row.get(2)?,
        subtotal_iva5: row.get(3)?,
        subtotal_iva15: row.get(4)?,
        iva5: row.get(5)?,
        iva15: row.get(6)?,
        total: row.get(7)?,
        pago: row.get(8)?,
        cambio: row.get(9)?,
        unidades: row.get(10)?,
        descuento: row.get(11)?,
        cliente_nombre: row.get(12)?,
        cliente_identificacion: row.get(13)?,
        total_devuelto: redondear_monto(row.get(14)?),
        credito: row.get(15)?,
        devolucion_id: row.get(16)?,
    })
}

// Búsqueda rápida para el punto de venta: por código o detalle, con la coincidencia exacta de
// código primero (útil con lector de código de barras). Sin texto, muestra los primeros productos.
#[tauri::command]
fn buscar_productos_venta(
    state: tauri::State<'_, AppState>,
    busqueda: Option<String>,
) -> Result<Vec<Producto>, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;

    let texto = busqueda
        .as_deref()
        .map(|t| t.trim().to_uppercase())
        .unwrap_or_default();

    // Palabras sueltas en cualquier orden; el código exacto (lector de barras) va primero.
    let (clausula, mut valores) = construir_filtro(&busqueda, &None, &None);
    valores.push((":texto", Value::Text(texto)));
    valores.push((":limite", Value::Integer(RESULTADOS_BUSQUEDA_VENTA)));

    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM productos {}
             ORDER BY CASE WHEN codigo = :texto THEN 0 ELSE 1 END, detalle
             LIMIT :limite",
            COLUMNAS_PRODUCTO, clausula
        ))
        .map_err(|e| e.to_string())?;

    stmt.query_map(&como_parametros(&valores)[..], mapear_producto)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

// Datos actuales de los productos que están en las ventas abiertas (precio, stock, detalle...).
// Las ventas abiertas guardan una copia del producto del momento en que se agregó; con esto se
// refresca al volver a la pantalla de venta. Los que ya no existen simplemente no vienen.
const MAX_PRODUCTOS_REFRESCO: usize = 500;

#[tauri::command]
fn obtener_productos_por_ids(state: tauri::State<'_, AppState>, ids: Vec<i64>) -> Result<Vec<Producto>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    if ids.len() > MAX_PRODUCTOS_REFRESCO {
        return Err("Demasiados productos.".to_string());
    }
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    let marcadores = vec!["?"; ids.len()].join(", ");
    let mut stmt = conn
        .prepare(&format!("SELECT {} FROM productos WHERE id IN ({})", COLUMNAS_PRODUCTO, marcadores))
        .map_err(|e| e.to_string())?;
    stmt.query_map(rusqlite::params_from_iter(ids.iter()), mapear_producto)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

// Registra una venta completa en una sola transacción: valida stock, calcula importes con los
// precios actuales de la base (no con los que manda el frontend), descuenta stock y deja el
// movimiento en el historial de cada producto. Si algo falla, no se guarda nada.
#[tauri::command]
fn registrar_venta(
    state: tauri::State<'_, AppState>,
    items: Vec<ItemVenta>,
    pago: f64,
    cliente_id: Option<i64>,
    // Cambio de producto: devolución (con reembolso CAMBIO, aún sin usar) cuyo total se descuenta
    // de lo que paga el cliente. Si el crédito supera el total, la diferencia se le entrega como cambio.
    devolucion_id: Option<i64>,
) -> Result<Venta, String> {
    if items.is_empty() {
        return Err("Agrega al menos un producto a la venta.".to_string());
    }

    // Cada producto va una sola vez (con su propio precio y descuento).
    let mut vistos: Vec<i64> = Vec::new();
    for item in &items {
        if item.cantidad <= 0 {
            return Err("Las cantidades deben ser mayores a 0.".to_string());
        }
        if !item.precio.is_finite() || a_centavos(item.precio) <= 0 {
            return Err("El precio de cada producto debe ser mayor a 0.".to_string());
        }
        if !item.descuento.is_finite() || item.descuento < 0.0 {
            return Err("El descuento no puede ser negativo.".to_string());
        }
        if vistos.contains(&item.producto_id) {
            return Err("Hay un producto repetido en la venta.".to_string());
        }
        vistos.push(item.producto_id);
    }

    if !pago.is_finite() || pago < 0.0 {
        return Err("Ingresa un monto de pago válido.".to_string());
    }

    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // Cliente opcional: si viene, debe existir. Se guarda una copia de su nombre e identificación.
    let cliente: Option<(i64, String, String)> = match cliente_id {
        None => None,
        Some(id) => {
            let fila = tx
                .query_row(
                    "SELECT id, nombre, identificacion FROM clientes WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match fila {
                Some(c) => Some(c),
                None => return Err("El cliente seleccionado ya no existe.".to_string()),
            }
        }
    };

    struct Linea {
        producto_id: i64,
        codigo: String,
        detalle: String,
        medida: String,
        cantidad: i32,
        precio_lista_centavos: i64,
        precio_centavos: i64,
        descuento_pct: f64,
        descuento_centavos: i64,
        iva: String,
        subtotal_centavos: i64,
        stock: i32,
    }

    let mut lineas = Vec::new();
    let (mut sub_cero, mut sub_iva5, mut sub_iva15) = (0i64, 0i64, 0i64);
    let mut descuento_total = 0i64;

    for item in &items {
        let producto_id = item.producto_id;
        let cantidad = item.cantidad;
        let fila = tx
            .query_row(
                "SELECT codigo, detalle, precio, iva, stock, medida FROM productos WHERE id = ?1",
                params![producto_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, f64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i32>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let Some((codigo, detalle, precio, iva, stock, medida)) = fila else {
            return Err("Uno de los productos de la venta ya no existe.".to_string());
        };

        if cantidad > stock {
            return Err(format!(
                "No hay suficiente stock de {} (disponible: {}).",
                detalle, stock
            ));
        }

        // El precio de lista es el del catálogo; el cobrado es el que se editó en la venta.
        // El descuento es un monto en dólares sobre el total de la línea (precio cobrado × cantidad)
        // y el IVA se calcula sobre el neto. Debe coincidir con calcularLinea en src/views/venta.tsx.
        let precio_lista_centavos = a_centavos(precio);
        let precio_centavos = a_centavos(item.precio);
        let bruto = precio_centavos * cantidad as i64;
        let descuento_centavos = a_centavos(item.descuento);
        if descuento_centavos > bruto {
            return Err(format!(
                "El descuento de {} (${:.2}) no puede ser mayor al total de la línea (${:.2}).",
                detalle,
                de_centavos(descuento_centavos),
                de_centavos(bruto)
            ));
        }
        // Se guarda también el porcentaje equivalente, solo como referencia.
        let descuento_pct = if bruto > 0 {
            ((descuento_centavos as f64) * 10000.0 / (bruto as f64)).round() / 100.0
        } else {
            0.0
        };
        let subtotal_centavos = bruto - descuento_centavos;
        descuento_total += descuento_centavos;
        match porcentaje_iva(&iva) {
            15 => sub_iva15 += subtotal_centavos,
            5 => sub_iva5 += subtotal_centavos,
            _ => sub_cero += subtotal_centavos,
        }

        lineas.push(Linea {
            producto_id,
            codigo,
            detalle,
            medida,
            cantidad,
            precio_lista_centavos,
            precio_centavos,
            descuento_pct,
            descuento_centavos,
            iva,
            subtotal_centavos,
            stock,
        });
    }

    let iva5 = calcular_iva(sub_iva5, 5);
    let iva15 = calcular_iva(sub_iva15, 15);
    let total = sub_cero + sub_iva5 + sub_iva15 + iva5 + iva15;
    let pago_centavos = a_centavos(pago);

    let credito = match devolucion_id {
        None => 0,
        Some(id) => credito_disponible(&tx, id)?,
    };

    if pago_centavos + credito < total {
        return Err(format!(
            "El pago (${:.2}) es menor al total a cobrar (${:.2}).",
            de_centavos(pago_centavos),
            de_centavos(total - credito)
        ));
    }
    let cambio = pago_centavos + credito - total;

    tx.execute(
        "INSERT INTO ventas (fecha, subtotal_cero, subtotal_iva5, subtotal_iva15, iva5, iva15, total, pago, cambio, descuento,
                             cliente_id, cliente_nombre, cliente_identificacion, devolucion_id, credito)
         VALUES (datetime('now', 'localtime'), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            de_centavos(sub_cero),
            de_centavos(sub_iva5),
            de_centavos(sub_iva15),
            de_centavos(iva5),
            de_centavos(iva15),
            de_centavos(total),
            de_centavos(pago_centavos),
            de_centavos(cambio),
            de_centavos(descuento_total),
            cliente.as_ref().map(|c| c.0),
            cliente.as_ref().map(|c| c.1.clone()).unwrap_or_default(),
            cliente.as_ref().map(|c| c.2.clone()).unwrap_or_default(),
            devolucion_id,
            de_centavos(credito),
        ],
    )
    .map_err(|e| e.to_string())?;
    let venta_id = tx.last_insert_rowid();

    for linea in &lineas {
        tx.execute(
            "INSERT INTO venta_detalle (venta_id, producto_id, codigo, detalle, cantidad, precio_unitario, iva, subtotal, medida,
                                        precio_lista, descuento_pct, descuento)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                venta_id,
                linea.producto_id,
                linea.codigo,
                linea.detalle,
                linea.cantidad,
                de_centavos(linea.precio_centavos),
                linea.iva,
                de_centavos(linea.subtotal_centavos),
                linea.medida,
                de_centavos(linea.precio_lista_centavos),
                linea.descuento_pct,
                de_centavos(linea.descuento_centavos),
            ],
        )
        .map_err(|e| e.to_string())?;

        tx.execute(
            "UPDATE productos SET stock = stock - ?1 WHERE id = ?2",
            params![linea.cantidad, linea.producto_id],
        )
        .map_err(|e| e.to_string())?;

        registrar_movimiento(&tx, linea.producto_id, "VENTA", linea.cantidad, linea.stock - linea.cantidad)
            .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;

    conn.query_row(&format!("{} WHERE v.id = ?1", SELECT_VENTA), params![venta_id], mapear_venta)
        .map_err(|e| e.to_string())
}

// Historial de ventas paginado (más recientes primero), con el resumen del día.
#[tauri::command]
fn obtener_ventas(state: tauri::State<'_, AppState>, pagina: i64) -> Result<PaginaVentas, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;

    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM ventas", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let total_paginas = ((total as f64) / (VENTAS_POR_PAGINA as f64)).ceil().max(1.0) as i64;
    let pagina = pagina.clamp(1, total_paginas);
    let offset = (pagina - 1) * VENTAS_POR_PAGINA;

    let mut stmt = conn
        .prepare(&format!("{} ORDER BY v.id DESC LIMIT ?1 OFFSET ?2", SELECT_VENTA))
        .map_err(|e| e.to_string())?;
    let ventas = stmt
        .query_map(params![VENTAS_POR_PAGINA, offset], mapear_venta)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    // Monto neto del día: ventas menos devoluciones hechas hoy.
    let (ventas_hoy, monto_hoy): (i64, f64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(total), 0)
                    - (SELECT COALESCE(SUM(total), 0) FROM devoluciones
                       WHERE date(fecha) = date('now', 'localtime'))
             FROM ventas
             WHERE date(fecha) = date('now', 'localtime')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    Ok(PaginaVentas {
        ventas,
        total,
        pagina,
        ventas_hoy,
        monto_hoy: de_centavos(a_centavos(monto_hoy)),
    })
}

#[tauri::command]
fn obtener_detalle_venta(
    state: tauri::State<'_, AppState>,
    venta_id: i64,
) -> Result<Vec<DetalleVenta>, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;

    let mut stmt = conn
        .prepare(
            "SELECT d.id, d.codigo, d.detalle, d.cantidad, d.precio_unitario, d.iva, d.subtotal, d.medida,
                    d.precio_lista, d.descuento_pct, d.descuento,
                    (SELECT COALESCE(SUM(dd.cantidad), 0) FROM devolucion_detalle dd WHERE dd.venta_detalle_id = d.id)
             FROM venta_detalle d WHERE d.venta_id = ?1 ORDER BY d.id",
        )
        .map_err(|e| e.to_string())?;

    stmt.query_map(params![venta_id], |row| {
        Ok(DetalleVenta {
            id: row.get(0)?,
            codigo: row.get(1)?,
            detalle: row.get(2)?,
            cantidad: row.get(3)?,
            precio_unitario: row.get(4)?,
            iva: row.get(5)?,
            subtotal: row.get(6)?,
            medida: row.get(7)?,
            precio_lista: row.get(8)?,
            descuento_pct: row.get(9)?,
            descuento: row.get(10)?,
            devuelto: row.get(11)?,
        })
    })
    .map_err(|e| e.to_string())?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------
// Devoluciones y cambios
// ---------------------------------------------------------------------------------------------

// Debe coincidir con REEMBOLSOS en src/views/venta.tsx
const REEMBOLSOS: [&str; 2] = ["EFECTIVO", "CAMBIO"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemDevolucion {
    venta_detalle_id: i64,
    cantidad: i32,
    // false = el producto vuelve dañado y no se suma al stock.
    regresa_stock: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Devolucion {
    id: i64,
    venta_id: i64,
    fecha: String,
    motivo: String,
    reembolso: String,
    subtotal_cero: f64,
    subtotal_iva5: f64,
    subtotal_iva15: f64,
    iva5: f64,
    iva15: f64,
    total: f64,
    unidades: i64,
    // Venta en la que se usó el crédito (solo para reembolso CAMBIO). None = pendiente.
    usada_en_venta: Option<i64>,
}

const SELECT_DEVOLUCION: &str = "SELECT d.id, d.venta_id, d.fecha, d.motivo, d.reembolso,
            d.subtotal_cero, d.subtotal_iva5, d.subtotal_iva15, d.iva5, d.iva15, d.total,
            (SELECT COALESCE(SUM(dd.cantidad), 0) FROM devolucion_detalle dd WHERE dd.devolucion_id = d.id),
            (SELECT v.id FROM ventas v WHERE v.devolucion_id = d.id)
     FROM devoluciones d";

fn mapear_devolucion(row: &rusqlite::Row) -> rusqlite::Result<Devolucion> {
    Ok(Devolucion {
        id: row.get(0)?,
        venta_id: row.get(1)?,
        fecha: row.get(2)?,
        motivo: row.get(3)?,
        reembolso: row.get(4)?,
        subtotal_cero: row.get(5)?,
        subtotal_iva5: row.get(6)?,
        subtotal_iva15: row.get(7)?,
        iva5: row.get(8)?,
        iva15: row.get(9)?,
        total: row.get(10)?,
        unidades: row.get(11)?,
        usada_en_venta: row.get(12)?,
    })
}

// Parte proporcional de un importe en centavos (total × parte / de), redondeada al centavo.
fn proporcion(total: i64, parte: i64, de: i64) -> i64 {
    if de <= 0 {
        return 0;
    }
    (total * parte * 2 + de) / (2 * de)
}

// Crédito (en centavos) de una devolución que se va a aplicar a una venta nueva. Debe ser de tipo
// CAMBIO y no haberse usado antes.
fn credito_disponible(conn: &Connection, devolucion_id: i64) -> Result<i64, String> {
    let fila = conn
        .query_row(&format!("{} WHERE d.id = ?1", SELECT_DEVOLUCION), params![devolucion_id], mapear_devolucion)
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(dev) = fila else {
        return Err("La devolución para el cambio ya no existe.".to_string());
    };
    if dev.reembolso != "CAMBIO" {
        return Err("Esa devolución se reembolsó en efectivo; no se puede usar como crédito.".to_string());
    }
    if let Some(venta) = dev.usada_en_venta {
        return Err(format!("El crédito de esa devolución ya se usó en la venta N.º {}.", venta));
    }
    Ok(a_centavos(dev.total))
}

// Registra una devolución (total o parcial) de una venta en una sola transacción.
// - Solo se puede devolver lo vendido menos lo ya devuelto en devoluciones anteriores.
// - Los importes salen de la venta original (precio cobrado, descuento e IVA de ese momento), nunca
//   del precio actual del catálogo. Se calculan de forma acumulada para que, si al final se devuelve
//   todo, la suma de devoluciones sea exactamente el total de la venta (sin diferencias de redondeo).
// - Lo que regresa en buen estado vuelve al stock con un movimiento DEVOLUCION.
#[tauri::command]
fn registrar_devolucion(
    state: tauri::State<'_, AppState>,
    venta_id: i64,
    items: Vec<ItemDevolucion>,
    motivo: String,
    reembolso: String,
) -> Result<Devolucion, String> {
    let motivo = motivo.trim().to_string();
    if motivo.is_empty() {
        return Err("Indica el motivo de la devolución.".to_string());
    }
    if !REEMBOLSOS.contains(&reembolso.as_str()) {
        return Err("Forma de reembolso no válida.".to_string());
    }
    let items: Vec<&ItemDevolucion> = items.iter().filter(|i| i.cantidad != 0).collect();
    if items.is_empty() {
        return Err("Elige al menos un producto a devolver.".to_string());
    }
    let mut vistos: Vec<i64> = Vec::new();
    for item in &items {
        if item.cantidad < 0 {
            return Err("Las cantidades no pueden ser negativas.".to_string());
        }
        if vistos.contains(&item.venta_detalle_id) {
            return Err("Hay un producto repetido en la devolución.".to_string());
        }
        vistos.push(item.venta_detalle_id);
    }

    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let existe: bool = tx
        .query_row("SELECT COUNT(*) > 0 FROM ventas WHERE id = ?1", params![venta_id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if !existe {
        return Err("La venta ya no existe.".to_string());
    }

    struct Linea {
        venta_detalle_id: i64,
        producto_id: i64,
        codigo: String,
        detalle: String,
        cantidad: i32,
        precio_unitario: f64,
        iva: String,
        subtotal_centavos: i64,
        regresa_stock: bool,
    }

    let mut lineas = Vec::new();
    let (mut sub_cero, mut sub_iva5, mut sub_iva15) = (0i64, 0i64, 0i64);

    for item in &items {
        let fila = tx
            .query_row(
                "SELECT d.producto_id, d.codigo, d.detalle, d.cantidad, d.precio_unitario, d.iva, d.subtotal,
                        (SELECT COALESCE(SUM(dd.cantidad), 0) FROM devolucion_detalle dd WHERE dd.venta_detalle_id = d.id)
                 FROM venta_detalle d WHERE d.id = ?1 AND d.venta_id = ?2",
                params![item.venta_detalle_id, venta_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i32>(3)?,
                        row.get::<_, f64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, f64>(6)?,
                        row.get::<_, i32>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((producto_id, codigo, detalle, vendida, precio_unitario, iva, subtotal, devuelta)) = fila else {
            return Err("Uno de los productos no pertenece a esta venta.".to_string());
        };

        let disponible = vendida - devuelta;
        if item.cantidad > disponible {
            return Err(format!(
                "Solo se pueden devolver {} unidad(es) de {}.",
                disponible.max(0),
                detalle
            ));
        }

        // Subtotal neto (con descuento) proporcional a lo devuelto, calculado de forma acumulada.
        let sub_linea = a_centavos(subtotal);
        let subtotal_centavos = proporcion(sub_linea, (devuelta + item.cantidad) as i64, vendida as i64)
            - proporcion(sub_linea, devuelta as i64, vendida as i64);
        match porcentaje_iva(&iva) {
            15 => sub_iva15 += subtotal_centavos,
            5 => sub_iva5 += subtotal_centavos,
            _ => sub_cero += subtotal_centavos,
        }

        if item.regresa_stock {
            let existe_producto: bool = tx
                .query_row("SELECT COUNT(*) > 0 FROM productos WHERE id = ?1", params![producto_id], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            if !existe_producto {
                return Err(format!(
                    "{} ya no existe en el catálogo: márcalo como que no regresa al stock.",
                    detalle
                ));
            }
        }

        lineas.push(Linea {
            venta_detalle_id: item.venta_detalle_id,
            producto_id,
            codigo,
            detalle,
            cantidad: item.cantidad,
            precio_unitario,
            iva,
            subtotal_centavos,
            regresa_stock: item.regresa_stock,
        });
    }

    // IVA acumulado: IVA de (lo ya devuelto + esta devolución) menos el IVA ya devuelto antes.
    let (prev_base5, prev_iva5, prev_base15, prev_iva15): (f64, f64, f64, f64) = tx
        .query_row(
            "SELECT COALESCE(SUM(subtotal_iva5), 0), COALESCE(SUM(iva5), 0),
                    COALESCE(SUM(subtotal_iva15), 0), COALESCE(SUM(iva15), 0)
             FROM devoluciones WHERE venta_id = ?1",
            params![venta_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;
    let iva5 = (calcular_iva(a_centavos(prev_base5) + sub_iva5, 5) - a_centavos(prev_iva5)).max(0);
    let iva15 = (calcular_iva(a_centavos(prev_base15) + sub_iva15, 15) - a_centavos(prev_iva15)).max(0);
    let total = sub_cero + sub_iva5 + sub_iva15 + iva5 + iva15;

    tx.execute(
        "INSERT INTO devoluciones (venta_id, fecha, motivo, reembolso, subtotal_cero, subtotal_iva5, subtotal_iva15,
                                   iva5, iva15, total)
         VALUES (?1, datetime('now', 'localtime'), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            venta_id,
            motivo,
            reembolso,
            de_centavos(sub_cero),
            de_centavos(sub_iva5),
            de_centavos(sub_iva15),
            de_centavos(iva5),
            de_centavos(iva15),
            de_centavos(total),
        ],
    )
    .map_err(|e| e.to_string())?;
    let devolucion_id = tx.last_insert_rowid();

    for linea in &lineas {
        tx.execute(
            "INSERT INTO devolucion_detalle (devolucion_id, venta_detalle_id, producto_id, codigo, detalle, cantidad,
                                             precio_unitario, iva, subtotal, regresa_stock)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                devolucion_id,
                linea.venta_detalle_id,
                linea.producto_id,
                linea.codigo,
                linea.detalle,
                linea.cantidad,
                linea.precio_unitario,
                linea.iva,
                de_centavos(linea.subtotal_centavos),
                linea.regresa_stock,
            ],
        )
        .map_err(|e| e.to_string())?;

        if linea.regresa_stock {
            tx.execute(
                "UPDATE productos SET stock = stock + ?1 WHERE id = ?2",
                params![linea.cantidad, linea.producto_id],
            )
            .map_err(|e| e.to_string())?;
            let stock_resultante = obtener_stock_actual(&tx, linea.producto_id).map_err(|e| e.to_string())?;
            registrar_movimiento(&tx, linea.producto_id, "DEVOLUCION", linea.cantidad, stock_resultante)
                .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    conn.query_row(&format!("{} WHERE d.id = ?1", SELECT_DEVOLUCION), params![devolucion_id], mapear_devolucion)
        .map_err(|e| e.to_string())
}

// Devoluciones de una venta, más antiguas primero.
#[tauri::command]
fn obtener_devoluciones_venta(
    state: tauri::State<'_, AppState>,
    venta_id: i64,
) -> Result<Vec<Devolucion>, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    let mut stmt = conn
        .prepare(&format!("{} WHERE d.venta_id = ?1 ORDER BY d.id", SELECT_DEVOLUCION))
        .map_err(|e| e.to_string())?;
    stmt.query_map(params![venta_id], mapear_devolucion)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod pruebas_devoluciones {
    use super::{calcular_iva, proporcion};

    #[test]
    fn devoluciones_parciales_suman_el_total() {
        // Línea de 3 unidades con subtotal $10.00: devolver 1 + 1 + 1 debe sumar exactamente $10.00.
        let sub = 1000;
        let partes: Vec<i64> = (0..3).map(|i| proporcion(sub, i + 1, 3) - proporcion(sub, i, 3)).collect();
        assert_eq!(partes.iter().sum::<i64>(), sub);

        // IVA acumulado: la suma de los IVA devueltos coincide con el IVA de la venta completa.
        let mut base = 0;
        let mut iva_devuelto = 0;
        for parte in &partes {
            let iva = calcular_iva(base + parte, 15) - iva_devuelto;
            base += parte;
            iva_devuelto += iva;
        }
        assert_eq!(iva_devuelto, calcular_iva(sub, 15));
    }
}

// ---------------------------------------------------------------------------------------------
// Panel principal
// ---------------------------------------------------------------------------------------------

// Debe coincidir con UMBRAL_STOCK_BAJO en src/views/inventario.tsx y src/views/dashboard.tsx
const UMBRAL_STOCK_BAJO: i32 = 5;
const DIAS_GRAFICO_VENTAS: i64 = 14;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VentasDia {
    fecha: String,
    total: f64,
    cantidad: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductoVendido {
    codigo: String,
    detalle: String,
    unidades: i64,
    monto: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductoAlerta {
    id: i64,
    codigo: String,
    detalle: String,
    stock: i32,
}

// Lo que el Panel no saca de obtener_reporte (los montos de hoy y del mes salen de ahí, para que
// coincidan exactamente con la sección Reportes). Debe coincidir con ResumenPanel en
// src/views/dashboard.tsx
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResumenPanel {
    total_productos: i64,
    productos_sin_stock: i64,
    productos_stock_bajo: i64,
    unidades_en_stock: i64,
    valor_inventario: f64,
    ventas_por_dia: Vec<VentasDia>,
    mas_vendidos: Vec<ProductoVendido>,
    alertas_stock: Vec<ProductoAlerta>,
    ultimas_ventas: Vec<Venta>,
}

// Redondea un importe sumado en SQL a 2 decimales exactos.
fn redondear_monto(valor: f64) -> f64 {
    de_centavos(a_centavos(valor))
}

// Totales de stock de todo el catálogo (sin filtros). Lo usan el Panel y los indicadores de Inventario.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResumenInventario {
    total_productos: i64,
    productos_sin_stock: i64,
    productos_stock_bajo: i64,
    unidades_en_stock: i64,
    valor_inventario: f64,
}

fn resumen_inventario(conn: &Connection) -> rusqlite::Result<ResumenInventario> {
    conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN stock > 0 AND stock <= ?1 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN stock > 0 THEN stock ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN stock > 0 THEN precio * stock ELSE 0 END), 0)
         FROM productos",
        params![UMBRAL_STOCK_BAJO],
        |row| {
            Ok(ResumenInventario {
                total_productos: row.get(0)?,
                productos_sin_stock: row.get(1)?,
                productos_stock_bajo: row.get(2)?,
                unidades_en_stock: row.get(3)?,
                valor_inventario: redondear_monto(row.get(4)?),
            })
        },
    )
}

#[tauri::command]
fn obtener_resumen_inventario(state: tauri::State<'_, AppState>) -> Result<ResumenInventario, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    resumen_inventario(conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn obtener_resumen_panel(state: tauri::State<'_, AppState>) -> Result<ResumenPanel, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    resumen_panel(conn).map_err(|e| e.to_string())
}

fn resumen_panel(conn: &Connection) -> rusqlite::Result<ResumenPanel> {
    let ResumenInventario {
        total_productos,
        productos_sin_stock,
        productos_stock_bajo,
        unidades_en_stock,
        valor_inventario,
    } = resumen_inventario(conn)?;

    // Un registro por cada uno de los últimos N días, incluidos los días sin ventas (en 0).
    let mut stmt = conn.prepare(
        "WITH RECURSIVE dias(d) AS (
             SELECT date('now', 'localtime', ?1)
             UNION ALL
             SELECT date(d, '+1 day') FROM dias WHERE d < date('now', 'localtime')
         )
         SELECT dias.d,
                COALESCE(SUM(v.total), 0)
                    - (SELECT COALESCE(SUM(dv.total), 0) FROM devoluciones dv WHERE date(dv.fecha) = dias.d),
                COUNT(v.id)
         FROM dias LEFT JOIN ventas v ON date(v.fecha) = dias.d
         GROUP BY dias.d ORDER BY dias.d",
    )?;
    let ventas_por_dia = stmt
        .query_map(params![format!("-{} days", DIAS_GRAFICO_VENTAS - 1)], |row| {
            Ok(VentasDia {
                fecha: row.get(0)?,
                total: redondear_monto(row.get(1)?),
                cantidad: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut stmt = conn.prepare(
        // Unidades y montos netos de lo devuelto.
        "SELECT d.codigo, d.detalle,
                SUM(d.cantidad - COALESCE(dd.cantidad, 0)) AS unidades,
                SUM(d.subtotal - COALESCE(dd.subtotal, 0)) AS monto
         FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
         LEFT JOIN (SELECT venta_detalle_id, SUM(cantidad) AS cantidad, SUM(subtotal) AS subtotal
                    FROM devolucion_detalle GROUP BY venta_detalle_id) dd ON dd.venta_detalle_id = d.id
         WHERE strftime('%Y-%m', v.fecha) = strftime('%Y-%m', 'now', 'localtime')
         GROUP BY d.producto_id
         HAVING unidades > 0
         ORDER BY unidades DESC, monto DESC
         LIMIT 5",
    )?;
    let mas_vendidos = stmt
        .query_map([], |row| {
            Ok(ProductoVendido {
                codigo: row.get(0)?,
                detalle: row.get(1)?,
                unidades: row.get(2)?,
                monto: redondear_monto(row.get(3)?),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut stmt = conn.prepare(
        "SELECT id, codigo, detalle, stock FROM productos
         WHERE stock <= ?1 ORDER BY stock ASC, detalle LIMIT 8",
    )?;
    let alertas_stock = stmt
        .query_map(params![UMBRAL_STOCK_BAJO], |row| {
            Ok(ProductoAlerta {
                id: row.get(0)?,
                codigo: row.get(1)?,
                detalle: row.get(2)?,
                stock: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut stmt = conn.prepare(&format!("{} ORDER BY v.id DESC LIMIT 5", SELECT_VENTA))?;
    let ultimas_ventas = stmt
        .query_map([], mapear_venta)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(ResumenPanel {
        total_productos,
        productos_sin_stock,
        productos_stock_bajo,
        unidades_en_stock,
        valor_inventario,
        ventas_por_dia,
        mas_vendidos,
        alertas_stock,
        ultimas_ventas,
    })
}

// ---------------------------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------------------------

const CLIENTES_POR_PAGINA: i64 = 20;
const RESULTADOS_BUSQUEDA_CLIENTE: i64 = 8;
// Debe coincidir con TIPOS_IDENTIFICACION en src/components/cliente-form.tsx
const TIPOS_IDENTIFICACION: [&str; 3] = ["CEDULA", "RUC", "PASAPORTE"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Cliente {
    id: i64,
    tipo_identificacion: String,
    identificacion: String,
    nombre: String,
    telefono: String,
    email: String,
    direccion: String,
    fecha_registro: String,
    compras: i64,
    total_comprado: f64,
    ultima_compra: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PaginaClientes {
    clientes: Vec<Cliente>,
    total: i64,
    pagina: i64,
}

// Cédula ecuatoriana: 10 dígitos, provincia 01–24 (o 30 para extranjeros), tercer dígito < 6 y
// dígito verificador por módulo 10.
fn cedula_valida(cedula: &str) -> bool {
    if cedula.len() != 10 || !cedula.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let d: Vec<u32> = cedula.chars().map(|c| c.to_digit(10).unwrap()).collect();
    let provincia = d[0] * 10 + d[1];
    if !((1..=24).contains(&provincia) || provincia == 30) || d[2] >= 6 {
        return false;
    }
    let suma: u32 = d[..9]
        .iter()
        .enumerate()
        .map(|(i, &x)| {
            let p = if i % 2 == 0 { x * 2 } else { x };
            if p > 9 { p - 9 } else { p }
        })
        .sum();
    (10 - suma % 10) % 10 == d[9]
}

struct DatosCliente {
    tipo_identificacion: String,
    identificacion: String,
    nombre: String,
    telefono: String,
    email: String,
    direccion: String,
}

// Limpia y valida los datos de un cliente (respaldo de la validación del frontend).
fn preparar_cliente(
    tipo_identificacion: String,
    identificacion: String,
    nombre: String,
    telefono: Option<String>,
    email: Option<String>,
    direccion: Option<String>,
) -> Result<DatosCliente, String> {
    let tipo = tipo_identificacion.trim().to_uppercase();
    let identificacion = identificacion.trim().to_uppercase();
    let nombre = nombre.trim().to_uppercase();
    let telefono = telefono.unwrap_or_default().trim().to_string();
    let email = email.unwrap_or_default().trim().to_lowercase();
    let direccion = direccion.unwrap_or_default().trim().to_uppercase();

    if !TIPOS_IDENTIFICACION.contains(&tipo.as_str()) {
        return Err("Selecciona un tipo de identificación válido.".to_string());
    }
    match tipo.as_str() {
        "CEDULA" if !cedula_valida(&identificacion) => {
            return Err("La cédula no es válida.".to_string());
        }
        "RUC" if identificacion.len() != 13 || !identificacion.chars().all(|c| c.is_ascii_digit()) => {
            return Err("El RUC debe tener 13 dígitos.".to_string());
        }
        "PASAPORTE"
            if !(3..=20).contains(&identificacion.len())
                || !identificacion.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            return Err("El pasaporte debe tener de 3 a 20 letras o números.".to_string());
        }
        _ => {}
    }
    if nombre.chars().count() < 2 {
        return Err("El nombre es obligatorio.".to_string());
    }
    if !email.is_empty() && !(email.contains('@') && email.contains('.')) {
        return Err("El email no es válido.".to_string());
    }

    Ok(DatosCliente {
        tipo_identificacion: tipo,
        identificacion,
        nombre,
        telefono,
        email,
        direccion,
    })
}

fn mapear_error_cliente(err: rusqlite::Error) -> String {
    if es_duplicado(&err) {
        return "Ya existe un cliente con esa identificación.".to_string();
    }
    err.to_string()
}

const SELECT_CLIENTE: &str = "SELECT c.id, c.tipo_identificacion, c.identificacion, c.nombre, c.telefono,
            c.email, c.direccion, c.fecha_registro,
            COUNT(v.id),
            COALESCE(SUM(v.total), 0)
                - (SELECT COALESCE(SUM(dv.total), 0) FROM devoluciones dv
                   JOIN ventas v2 ON v2.id = dv.venta_id WHERE v2.cliente_id = c.id),
            MAX(v.fecha)
     FROM clientes c LEFT JOIN ventas v ON v.cliente_id = c.id";

// WHERE de la búsqueda de clientes: palabras sueltas en nombre, identificación o teléfono.
fn filtro_cliente(texto: &str) -> (String, Vec<(&'static str, Value)>) {
    match condicion_palabras(texto, TEXTO_CLIENTE) {
        Some((condicion, valores)) => (format!("WHERE {}", condicion), valores),
        None => (String::new(), Vec::new()),
    }
}

fn mapear_cliente(row: &rusqlite::Row) -> rusqlite::Result<Cliente> {
    let total: f64 = row.get(9)?;
    Ok(Cliente {
        id: row.get(0)?,
        tipo_identificacion: row.get(1)?,
        identificacion: row.get(2)?,
        nombre: row.get(3)?,
        telefono: row.get(4)?,
        email: row.get(5)?,
        direccion: row.get(6)?,
        fecha_registro: row.get(7)?,
        compras: row.get(8)?,
        total_comprado: de_centavos(a_centavos(total)),
        ultima_compra: row.get(10)?,
    })
}

fn obtener_cliente(conn: &Connection, id: i64) -> rusqlite::Result<Cliente> {
    conn.query_row(
        &format!("{} WHERE c.id = ?1 GROUP BY c.id", SELECT_CLIENTE),
        params![id],
        mapear_cliente,
    )
}

#[tauri::command]
fn obtener_clientes(
    state: tauri::State<'_, AppState>,
    pagina: i64,
    busqueda: Option<String>,
) -> Result<PaginaClientes, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;

    let (filtro, mut valores) = filtro_cliente(busqueda.as_deref().unwrap_or(""));

    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM clientes c {}", filtro),
            &como_parametros(&valores)[..],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let total_paginas = ((total as f64) / (CLIENTES_POR_PAGINA as f64)).ceil().max(1.0) as i64;
    let pagina = pagina.clamp(1, total_paginas);
    let offset = (pagina - 1) * CLIENTES_POR_PAGINA;

    let mut stmt = conn
        .prepare(&format!(
            "{} {} GROUP BY c.id ORDER BY c.nombre LIMIT :limite OFFSET :offset",
            SELECT_CLIENTE, filtro
        ))
        .map_err(|e| e.to_string())?;
    valores.push((":limite", Value::Integer(CLIENTES_POR_PAGINA)));
    valores.push((":offset", Value::Integer(offset)));
    let clientes = stmt
        .query_map(&como_parametros(&valores)[..], mapear_cliente)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(PaginaClientes { clientes, total, pagina })
}

// Búsqueda rápida para elegir el cliente en una venta (identificación exacta primero).
#[tauri::command]
fn buscar_clientes(state: tauri::State<'_, AppState>, busqueda: String) -> Result<Vec<Cliente>, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;

    let (filtro, mut valores) = filtro_cliente(&busqueda);
    valores.push((":texto", Value::Text(busqueda.trim().to_uppercase())));
    valores.push((":limite", Value::Integer(RESULTADOS_BUSQUEDA_CLIENTE)));
    let mut stmt = conn
        .prepare(&format!(
            "{} {} GROUP BY c.id
             ORDER BY CASE WHEN c.identificacion = :texto THEN 0 ELSE 1 END, c.nombre
             LIMIT :limite",
            SELECT_CLIENTE, filtro
        ))
        .map_err(|e| e.to_string())?;
    stmt.query_map(&como_parametros(&valores)[..], mapear_cliente)
    .map_err(|e| e.to_string())?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn agregar_cliente(
    state: tauri::State<'_, AppState>,
    tipo_identificacion: String,
    identificacion: String,
    nombre: String,
    telefono: Option<String>,
    email: Option<String>,
    direccion: Option<String>,
) -> Result<Cliente, String> {
    let d = preparar_cliente(tipo_identificacion, identificacion, nombre, telefono, email, direccion)?;
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    conn.execute(
        "INSERT INTO clientes (tipo_identificacion, identificacion, nombre, telefono, email, direccion, fecha_registro)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', 'localtime'))",
        params![d.tipo_identificacion, d.identificacion, d.nombre, d.telefono, d.email, d.direccion],
    )
    .map_err(mapear_error_cliente)?;
    obtener_cliente(conn, conn.last_insert_rowid()).map_err(|e| e.to_string())
}

#[tauri::command]
fn actualizar_cliente(
    state: tauri::State<'_, AppState>,
    id: i64,
    tipo_identificacion: String,
    identificacion: String,
    nombre: String,
    telefono: Option<String>,
    email: Option<String>,
    direccion: Option<String>,
) -> Result<Cliente, String> {
    let d = preparar_cliente(tipo_identificacion, identificacion, nombre, telefono, email, direccion)?;
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    conn.execute(
        "UPDATE clientes SET tipo_identificacion = ?1, identificacion = ?2, nombre = ?3, telefono = ?4,
                email = ?5, direccion = ?6
         WHERE id = ?7",
        params![d.tipo_identificacion, d.identificacion, d.nombre, d.telefono, d.email, d.direccion, id],
    )
    .map_err(mapear_error_cliente)?;
    obtener_cliente(conn, id).map_err(|e| e.to_string())
}

// Elimina el cliente. Sus ventas se conservan (con la copia del nombre guardada en cada venta).
#[tauri::command]
fn eliminar_cliente(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE ventas SET cliente_id = NULL WHERE cliente_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM clientes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

// Compras de un cliente, más recientes primero.
#[tauri::command]
fn obtener_ventas_cliente(state: tauri::State<'_, AppState>, cliente_id: i64) -> Result<Vec<Venta>, String> {
    let conn_guard = state.db.lock().unwrap();
    let conn = requerir_conexion(&conn_guard)?;
    let mut stmt = conn
        .prepare(&format!("{} WHERE v.cliente_id = ?1 ORDER BY v.id DESC LIMIT 100", SELECT_VENTA))
        .map_err(|e| e.to_string())?;
    stmt.query_map(params![cliente_id], mapear_venta)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod pruebas_clientes {
    use super::cedula_valida;

    #[test]
    fn valida_cedulas() {
        assert!(cedula_valida("1710034065"));
        assert!(!cedula_valida("1710034066"));
        assert!(!cedula_valida("12345"));
        assert!(!cedula_valida("9910034065"));
    }
}

// ESTA FUNCIÓN DEBE SER ABSOLUTAMENTE PÚBLICA (pub)
// Es el punto de entrada que main.rs necesita ejecutar.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .expect("no se pudo obtener el directorio de datos de la app");
            std::fs::create_dir_all(&dir).expect("no se pudo crear el directorio de datos de la app");

            // Si ya existe una base de datos (de un inicio anterior) la abrimos; si no, queda sin
            // configurar hasta que el usuario le ponga nombre desde la pantalla de primer inicio.
            let conn = buscar_base_existente(&dir)
                .map(|ruta| abrir_base_de_datos(ruta).expect("no se pudo abrir la base de datos SQLite"));

            app.manage(AppState {
                db: Mutex::new(conn),
            });

            // La ventana arranca oculta ("visible": false) y el frontend la muestra cuando ya pintó
            // con el tema correcto (evita el destello blanco). Por seguridad, si el frontend falla y
            // nunca la muestra, la mostramos nosotros a los 3 segundos.
            if let Some(ventana) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let _ = ventana.show();
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            obtener_configuracion_db,
            crear_base_de_datos,
            eliminar_base_de_datos,
            obtener_copias_seguridad,
            crear_copia_seguridad,
            eliminar_copia_seguridad,
            restaurar_copia_seguridad,
            abrir_carpeta_copias,
            obtener_categorias,
            agregar_categoria,
            renombrar_categoria,
            eliminar_categoria,
            agregar_producto,
            obtener_productos,
            actualizar_producto,
            eliminar_producto,
            obtener_inventario,
            agregar_stock,
            quitar_stock,
            obtener_movimientos,
            buscar_productos_venta,
            obtener_productos_por_ids,
            registrar_venta,
            obtener_ventas,
            obtener_detalle_venta,
            registrar_devolucion,
            obtener_devoluciones_venta,
            obtener_ventas_abiertas,
            guardar_ventas_abiertas,
            obtener_ajustes,
            guardar_ajuste,
            obtener_datos_negocio,
            guardar_datos_negocio,
            obtener_resumen_panel,
            obtener_resumen_inventario,
            obtener_clientes,
            buscar_clientes,
            agregar_cliente,
            actualizar_cliente,
            eliminar_cliente,
            obtener_ventas_cliente,
            reportes::obtener_reporte,
            reportes::exportar_excel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
