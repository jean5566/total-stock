mod db;
mod reportes;

use std::path::PathBuf;

use db::{con_nombre, es_duplicado, fila, filas, una_fila, FilaExt};
use libsql::{params, Connection, Row, Value};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::sync::Mutex;

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

// Base de datos abierta: libsql necesita conservar `Database` mientras se use la conexión.
// La ruta se guarda aparte porque libsql no la expone (se usa para copias y para borrar el archivo).
struct BaseActiva {
    _db: libsql::Database,
    conn: Connection,
    ruta: PathBuf,
}

// La base es None hasta que el usuario crea la base de datos en el primer inicio.
// Es un Mutex de tokio porque se mantiene tomado durante las consultas (que son async): así los
// comandos se ejecutan de a uno, como antes, y una transacción no se mezcla con otro comando.
struct AppState {
    db: Mutex<Option<BaseActiva>>,
}

async fn abrir_base_de_datos(ruta: PathBuf) -> libsql::Result<BaseActiva> {
    let db = libsql::Builder::new_local(&ruta).build().await?;
    let conn = db.connect()?;
    crear_esquema(&conn).await?;
    Ok(BaseActiva { _db: db, conn, ruta })
}

async fn crear_esquema(conn: &Connection) -> libsql::Result<()> {
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
        (),
    )
    .await?;

    // Evita códigos/SKU duplicados. Si la base ya tenía duplicados de antes (p. ej. por el bug de
    // guardado corregido previamente), la creación del índice falla y simplemente no se aplica la
    // restricción; no queremos impedir que la app arranque por datos de prueba viejos.
    let _ = conn
        .execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_productos_codigo ON productos (codigo)", ())
        .await;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS categorias (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL UNIQUE
        )",
        (),
    )
    .await?;

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
        (),
    )
    .await?;

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
        (),
    )
    .await?;

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
        (),
    )
    .await?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_venta_detalle_venta ON venta_detalle (venta_id)",
        (),
    )
    .await?;

    // Ajustes de la app como pares clave/valor (p. ej. usar_medida = "1").
    conn.execute(
        "CREATE TABLE IF NOT EXISTS configuracion (
            clave TEXT PRIMARY KEY,
            valor TEXT NOT NULL
        )",
        (),
    )
    .await?;

    // Columnas agregadas después de la primera versión: se crean si la base es anterior.
    asegurar_columna(conn, "productos", "medida", "TEXT NOT NULL DEFAULT ''").await?;
    asegurar_columna(conn, "venta_detalle", "medida", "TEXT NOT NULL DEFAULT ''").await?;
    asegurar_columna(conn, "productos", "aplicacion", "TEXT NOT NULL DEFAULT ''").await?;
    asegurar_columna(conn, "ventas", "descuento", "REAL NOT NULL DEFAULT 0").await?;
    asegurar_columna(conn, "venta_detalle", "precio_lista", "REAL NOT NULL DEFAULT 0").await?;
    asegurar_columna(conn, "venta_detalle", "descuento_pct", "REAL NOT NULL DEFAULT 0").await?;
    asegurar_columna(conn, "venta_detalle", "descuento", "REAL NOT NULL DEFAULT 0").await?;

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
        (),
    )
    .await?;
    asegurar_columna(conn, "ventas", "cliente_id", "INTEGER").await?;
    asegurar_columna(conn, "ventas", "cliente_nombre", "TEXT NOT NULL DEFAULT ''").await?;
    asegurar_columna(conn, "ventas", "cliente_identificacion", "TEXT NOT NULL DEFAULT ''").await?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas (cliente_id)", ()).await?;

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
        (),
    )
    .await?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_devoluciones_venta ON devoluciones (venta_id)", ()).await?;
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
        (),
    )
    .await?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_devolucion_detalle_dev ON devolucion_detalle (devolucion_id)",
        (),
    )
    .await?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_devolucion_detalle_linea ON devolucion_detalle (venta_detalle_id)",
        (),
    )
    .await?;
    // Venta hecha como cambio: devolución cuyo crédito se aplicó y monto de ese crédito.
    asegurar_columna(conn, "ventas", "devolucion_id", "INTEGER").await?;
    asegurar_columna(conn, "ventas", "credito", "REAL NOT NULL DEFAULT 0").await?;
    // Un crédito por devolución solo se puede usar en una venta.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_devolucion ON ventas (devolucion_id)
         WHERE devolucion_id IS NOT NULL",
        (),
    )
    .await?;

    Ok(())
}

// Agrega una columna a una tabla existente solo si todavía no existe (migración simple).
// `tabla`, `columna` y `definicion` son siempre literales de este archivo, nunca datos del usuario.
async fn asegurar_columna(
    conn: &Connection,
    tabla: &str,
    columna: &str,
    definicion: &str,
) -> libsql::Result<()> {
    let columnas: Vec<String> =
        filas(conn, &format!("PRAGMA table_info({})", tabla), (), |row| row.col(1)).await?;
    if !columnas.iter().any(|nombre| nombre == columna) {
        conn.execute(
            &format!("ALTER TABLE {} ADD COLUMN {} {}", tabla, columna, definicion),
            (),
        )
        .await?;
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

async fn info_de_conexion(base: &BaseActiva) -> libsql::Result<InfoBaseDatos> {
    let nombre = base
        .ruta
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "catalogo".to_string());
    let total_productos = contar_productos(&base.conn, &None, &None, &None).await?;

    Ok(InfoBaseDatos {
        nombre,
        ruta: base.ruta.to_string_lossy().to_string(),
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

async fn leer_ajuste_booleano(conn: &Connection, clave: &str) -> libsql::Result<bool> {
    Ok(leer_ajuste_texto(conn, clave).await? == "1")
}

async fn leer_ajustes(conn: &Connection) -> libsql::Result<Ajustes> {
    Ok(Ajustes {
        usar_medida: leer_ajuste_booleano(conn, "usar_medida").await?,
        usar_aplicacion: leer_ajuste_booleano(conn, "usar_aplicacion").await?,
    })
}

#[tauri::command]
async fn obtener_ajustes(state: tauri::State<'_, AppState>) -> Result<Ajustes, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    leer_ajustes(conn).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn guardar_ajuste(
    state: tauri::State<'_, AppState>,
    clave: String,
    activo: bool,
) -> Result<Ajustes, String> {
    if !AJUSTES_BOOLEANOS.contains(&clave.as_str()) {
        return Err("Ajuste no válido.".to_string());
    }
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    conn.execute(
        "INSERT INTO configuracion (clave, valor) VALUES (?1, ?2)
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor",
        params![clave, if activo { "1" } else { "0" }],
    )
    .await
    .map_err(|e| e.to_string())?;
    leer_ajustes(conn).await.map_err(|e| e.to_string())
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

async fn leer_ajuste_texto(conn: &Connection, clave: &str) -> libsql::Result<String> {
    let valor: Option<String> =
        una_fila(conn, "SELECT valor FROM configuracion WHERE clave = ?1", params![clave], |row| row.col(0))
            .await?;
    Ok(valor.unwrap_or_default())
}

// Ventas en curso (pestañas del punto de venta) guardadas como JSON, para recuperarlas si se cierra
// la app. El backend no interpreta el contenido: al cobrar, registrar_venta vuelve a validar todo.
const CLAVE_VENTAS_ABIERTAS: &str = "ventas_abiertas";
const MAX_BYTES_VENTAS_ABIERTAS: usize = 512 * 1024;

#[tauri::command]
async fn obtener_ventas_abiertas(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    leer_ajuste_texto(conn, CLAVE_VENTAS_ABIERTAS).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn guardar_ventas_abiertas(state: tauri::State<'_, AppState>, datos: String) -> Result<(), String> {
    if datos.len() > MAX_BYTES_VENTAS_ABIERTAS {
        return Err("Hay demasiadas ventas abiertas para guardarlas.".to_string());
    }
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    conn.execute(
        "INSERT INTO configuracion (clave, valor) VALUES (?1, ?2)
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor",
        params![CLAVE_VENTAS_ABIERTAS, datos],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn leer_datos_negocio(conn: &Connection) -> libsql::Result<DatosNegocio> {
    Ok(DatosNegocio {
        nombre_comercial: leer_ajuste_texto(conn, "negocio_nombre_comercial").await?,
        razon_social: leer_ajuste_texto(conn, "negocio_razon_social").await?,
        ruc: leer_ajuste_texto(conn, "negocio_ruc").await?,
        direccion: leer_ajuste_texto(conn, "negocio_direccion").await?,
        telefono: leer_ajuste_texto(conn, "negocio_telefono").await?,
        email: leer_ajuste_texto(conn, "negocio_email").await?,
    })
}

#[tauri::command]
async fn obtener_datos_negocio(state: tauri::State<'_, AppState>) -> Result<DatosNegocio, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    leer_datos_negocio(conn).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn guardar_datos_negocio(
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

    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;
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
            params![clave, valor.as_str()],
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;

    leer_datos_negocio(conn).await.map_err(|e| e.to_string())
}

// El precio se maneja siempre con 2 decimales (centavos).
fn redondear_precio(precio: f64) -> f64 {
    (precio * 100.0).round() / 100.0
}

// Traduce errores de SQLite a mensajes entendibles por el usuario (p. ej. código duplicado).
fn mapear_error_guardado(err: libsql::Error) -> String {
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

#[cfg(test)]
mod pruebas_busqueda {
    use super::*;

    async fn buscar(conn: &Connection, texto: &str) -> Vec<String> {
        let (clausula, valores) = construir_filtro(&Some(texto.to_string()), &None, &None);
        let sql = format!("SELECT detalle FROM productos {} ORDER BY id", clausula);
        filas(conn, &sql, con_nombre(&valores), |row| row.col(0)).await.unwrap()
    }

    #[tokio::test]
    async fn busca_palabras_en_cualquier_orden_y_sin_tildes() {
        let db = libsql::Builder::new_local(":memory:").build().await.unwrap();
        let conn = db.connect().unwrap();
        conn.execute_batch(
            "CREATE TABLE productos (id INTEGER PRIMARY KEY, codigo TEXT, detalle TEXT, categoria TEXT,
                                     medida TEXT, aplicacion TEXT, stock INTEGER);
             INSERT INTO productos VALUES
               (1, 'R-100', 'RODAMIENTO RUEDA DELANTERA', 'RODAMIENTOS', '6203-2RS', 'CHEVROLET AVEO 2008', 5),
               (2, 'V-200', 'VÁLVULA DE ADMISIÓN', 'MOTOR', '', 'SUZUKI FORSA', 5),
               (3, 'R-300', 'RODAMIENTO TRASERO', 'RODAMIENTOS', '6204', 'HYUNDAI ACCENT', 5),
               (4, 'X_1', 'PRODUCTO 100%', 'VARIOS', '', '', 5);",
        )
        .await
        .unwrap();

        assert_eq!(buscar(&conn, "aveo rodam").await, vec!["RODAMIENTO RUEDA DELANTERA"]);
        assert_eq!(buscar(&conn, "valvula admision").await, vec!["VÁLVULA DE ADMISIÓN"]);
        assert_eq!(
            buscar(&conn, "  rodamiento  ").await,
            vec!["RODAMIENTO RUEDA DELANTERA", "RODAMIENTO TRASERO"]
        );
        assert_eq!(buscar(&conn, "6203 delantera").await, vec!["RODAMIENTO RUEDA DELANTERA"]);
        assert!(buscar(&conn, "rodamiento suzuki").await.is_empty());
        // Los comodines de LIKE se buscan literalmente
        assert_eq!(buscar(&conn, "100%").await, vec!["PRODUCTO 100%"]);
        assert_eq!(buscar(&conn, "x_").await, vec!["PRODUCTO 100%"]);
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

async fn contar_productos(
    conn: &Connection,
    busqueda: &Option<String>,
    categoria: &Option<String>,
    estado_stock: &Option<String>,
) -> libsql::Result<i64> {
    let (clausula, valores) = construir_filtro(busqueda, categoria, estado_stock);
    let sql = format!("SELECT COUNT(*) FROM productos {}", clausula);
    fila(conn, &sql, con_nombre(&valores), |row| row.col(0)).await
}

// Columnas de un producto en el orden que espera mapear_producto.
const COLUMNAS_PRODUCTO: &str = "id, codigo, detalle, categoria, precio, iva, stock, medida, aplicacion";

fn mapear_producto(row: &Row) -> libsql::Result<Producto> {
    Ok(Producto {
        id: row.col(0)?,
        codigo: row.col(1)?,
        detalle: row.col(2)?,
        categoria: row.col(3)?,
        precio: row.col(4)?,
        iva: row.col(5)?,
        stock: row.col(6)?,
        medida: row.col(7)?,
        aplicacion: row.col(8)?,
    })
}

// Devuelve siempre una página válida (ajustada al rango existente) junto con el total de productos
// que cumplen los filtros, para no tener que cargar la tabla completa en el frontend.
// `orden_por` es siempre un literal fijo definido en este archivo (no viene del usuario), así que es
// seguro interpolarlo directamente en el SQL.
async fn listar_pagina(
    conn: &Connection,
    pagina_solicitada: i64,
    busqueda: &Option<String>,
    categoria: &Option<String>,
    estado_stock: &Option<String>,
    orden_por: &str,
) -> libsql::Result<PaginaProductos> {
    let total = contar_productos(conn, busqueda, categoria, estado_stock).await?;
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

    let productos = filas(conn, &sql, con_nombre(&valores), mapear_producto).await?;

    Ok(PaginaProductos {
        productos,
        total,
        pagina,
    })
}

// Las operaciones sobre productos requieren que ya exista una base de datos configurada.
fn requerir_conexion(base: &Option<BaseActiva>) -> Result<&Connection, String> {
    base.as_ref()
        .map(|b| &b.conn)
        .ok_or_else(|| "La base de datos no está configurada.".to_string())
}

#[tauri::command]
async fn obtener_configuracion_db(
    state: tauri::State<'_, AppState>,
) -> Result<Option<InfoBaseDatos>, String> {
    let guard = state.db.lock().await;
    match guard.as_ref() {
        None => Ok(None),
        Some(base) => info_de_conexion(base).await.map(Some).map_err(|e| e.to_string()),
    }
}

// Palabra que hay que escribir para confirmar el borrado. Debe coincidir con
// PALABRA_CONFIRMACION en src/views/configuracion.tsx
const PALABRA_CONFIRMACION: &str = "CONFIRMAR";

// Borra por completo la base de datos (productos, inventario, ventas, clientes y ajustes).
// Cierra la conexión, elimina el archivo .db y sus archivos auxiliares de SQLite, y deja la app
// sin base configurada para que se cree una nueva desde la pantalla de primer inicio.
#[tauri::command]
async fn eliminar_base_de_datos(state: tauri::State<'_, AppState>, confirmacion: String) -> Result<(), String> {
    if confirmacion.trim() != PALABRA_CONFIRMACION {
        return Err(format!("Escribe {} para eliminar la base de datos.", PALABRA_CONFIRMACION));
    }

    let mut guard = state.db.lock().await;
    let base = guard
        .take()
        .ok_or_else(|| "La base de datos no está configurada.".to_string())?;
    let ruta = base.ruta.clone();

    // En Windows el archivo no se puede borrar mientras la conexión esté abierta: al soltar
    // `base` se cierran la conexión y la base.
    drop(base);

    if let Err(e) = std::fs::remove_file(&ruta) {
        // Si no se pudo borrar, se vuelve a abrir para que la app no quede sin base.
        if let Ok(base) = abrir_base_de_datos(ruta.clone()).await {
            *guard = Some(base);
        }
        return Err(format!("No se pudo eliminar el archivo: {}", e));
    }
    for sufijo in ["-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{}{}", ruta.display(), sufijo));
    }
    Ok(())
}

#[tauri::command]
async fn crear_base_de_datos(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    nombre: String,
) -> Result<InfoBaseDatos, String> {
    let mut guard = state.db.lock().await;
    if guard.is_some() {
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
    let base = abrir_base_de_datos(ruta).await.map_err(|e| e.to_string())?;
    let info = info_de_conexion(&base).await.map_err(|e| e.to_string());
    *guard = Some(base);
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
async fn crear_copia(conn: &Connection, dir: &std::path::Path, tipo: &str) -> Result<PathBuf, String> {
    let fecha: String = fila(conn, "SELECT strftime('%Y-%m-%d_%H-%M-%S', 'now', 'localtime')", (), |row| row.col(0))
        .await
        .map_err(|e| e.to_string())?;
    let mut destino = dir.join(format!("{}_{}.db", fecha, tipo));
    // Dos copias en el mismo segundo: se agrega un número (VACUUM INTO exige que el archivo no exista)
    let mut n = 2;
    while destino.exists() {
        destino = dir.join(format!("{}_{}-{}.db", fecha, tipo, n));
        n += 1;
    }
    conn.execute("VACUUM INTO ?1", params![destino.to_string_lossy().to_string()])
        .await
        .map_err(|e| format!("No se pudo crear la copia de seguridad: {}", e))?;
    Ok(destino)
}

// true si el archivo es una base SQLite con la tabla de productos de esta app (se abre solo lectura).
async fn es_copia_valida(ruta: &std::path::Path) -> bool {
    let Ok(db) = libsql::Builder::new_local(ruta)
        .flags(libsql::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .build()
        .await
    else {
        return false;
    };
    let Ok(conn) = db.connect() else {
        return false;
    };
    let tablas: libsql::Result<i64> = fila(
        &conn,
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'productos'",
        (),
        |row| row.col(0),
    )
    .await;
    matches!(tablas, Ok(n) if n > 0)
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

    #[tokio::test]
    async fn crea_y_lista_copias() {
        let dir = std::env::temp_dir().join(format!("copias-prueba-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let base = abrir_base_de_datos(dir.join("base.db")).await.unwrap();
        let copia = crear_copia(&base.conn, &dir, "manual").await.unwrap();
        crear_copia(&base.conn, &dir, "antes-de-restaurar").await.unwrap();

        // La copia es una base válida con la tabla de productos; un archivo cualquiera no lo es.
        assert!(es_copia_valida(&copia).await);
        std::fs::write(dir.join("basura.db"), b"no es sqlite").unwrap();
        assert!(!es_copia_valida(&dir.join("basura.db")).await);
        std::fs::remove_file(dir.join("basura.db")).unwrap();

        let copias = listar_copias(&dir).unwrap();
        // base.db también está en este directorio de prueba, se excluye por el nombre
        let copias: Vec<_> = copias.into_iter().filter(|c| c.archivo != "base.db").collect();
        assert_eq!(copias.len(), 2);
        assert!(copias.iter().any(|c| c.automatica));
        assert_eq!(copias[0].fecha.len(), 19);

        // No acepta rutas fuera de la carpeta
        assert!(ruta_copia(&dir, "../otra.db").is_err());
        assert!(ruta_copia(&dir, &copias[0].archivo).is_ok());

        // Al soltar la base se cierra el archivo (en Windows no se puede borrar si sigue abierto).
        let ruta_base = base.ruta.clone();
        drop(base);
        std::fs::remove_file(&ruta_base).expect("la base cerrada se puede borrar");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[tauri::command]
fn obtener_copias_seguridad(app: tauri::AppHandle) -> Result<Vec<CopiaSeguridad>, String> {
    listar_copias(&directorio_copias(&app)?)
}

#[tauri::command]
async fn crear_copia_seguridad(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CopiaSeguridad>, String> {
    let dir = directorio_copias(&app)?;
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    crear_copia(conn, &dir, "manual").await?;
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
async fn restaurar_copia_seguridad(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    archivo: String,
) -> Result<InfoBaseDatos, String> {
    let dir = directorio_copias(&app)?;
    let origen = ruta_copia(&dir, &archivo)?;

    // Verifica que la copia sea una base válida de esta app antes de tocar nada.
    if !es_copia_valida(&origen).await {
        return Err("El archivo no es una copia válida.".to_string());
    }

    let mut guard = state.db.lock().await;
    let base = guard
        .take()
        .ok_or_else(|| "La base de datos no está configurada.".to_string())?;
    let ruta_actual = base.ruta.clone();

    let respaldo = match crear_copia(&base.conn, &dir, "antes-de-restaurar").await {
        Ok(r) => r,
        Err(e) => {
            *guard = Some(base);
            return Err(e);
        }
    };

    // En Windows el archivo no se puede reemplazar mientras la conexión esté abierta: al soltar
    // `base` se cierran la conexión y la base.
    drop(base);
    for sufijo in ["-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{}{}", ruta_actual.display(), sufijo));
    }

    // Copia y reabre; si algo falla, vuelve a dejar la base como estaba.
    let resultado = match std::fs::copy(&origen, &ruta_actual) {
        Ok(_) => abrir_base_de_datos(ruta_actual.clone()).await.map_err(|e| e.to_string()),
        Err(e) => Err(format!("No se pudo restaurar la copia: {}", e)),
    };

    let base = match resultado {
        Ok(base) => base,
        Err(e) => {
            let _ = std::fs::copy(&respaldo, &ruta_actual);
            if let Ok(base) = abrir_base_de_datos(ruta_actual.clone()).await {
                *guard = Some(base);
            }
            return Err(e);
        }
    };

    // La base se guarda antes de leer la info: si eso fallara, la app no debe quedar sin base.
    *guard = Some(base);
    let base = guard.as_ref().expect("recién guardada");
    info_de_conexion(base).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn abrir_carpeta_copias(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = directorio_copias(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

async fn listar_categorias(conn: &Connection) -> libsql::Result<Vec<String>> {
    filas(conn, "SELECT nombre FROM categorias ORDER BY nombre", (), |row| row.col(0)).await
}

#[tauri::command]
async fn obtener_categorias(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    listar_categorias(conn).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn agregar_categoria(
    state: tauri::State<'_, AppState>,
    nombre: String,
) -> Result<Vec<String>, String> {
    let nombre = nombre.trim().to_uppercase();
    if nombre.is_empty() {
        return Err("Escribe un nombre de categoría.".to_string());
    }

    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    conn.execute("INSERT INTO categorias (nombre) VALUES (?1)", params![nombre])
        .await
        .map_err(|e| {
            if es_duplicado(&e) {
                "Esa categoría ya existe.".to_string()
            } else {
                e.to_string()
            }
        })?;

    listar_categorias(conn).await.map_err(|e| e.to_string())
}

// Renombra una categoría y actualiza todos los productos que la usaban (los productos guardan el
// nombre como texto), en una sola transacción para que no queden datos a medias.
#[tauri::command]
async fn renombrar_categoria(
    state: tauri::State<'_, AppState>,
    nombre_actual: String,
    nombre_nuevo: String,
) -> Result<Vec<String>, String> {
    let nombre_actual = nombre_actual.trim().to_uppercase();
    let nombre_nuevo = nombre_nuevo.trim().to_uppercase();
    if nombre_nuevo.is_empty() {
        return Err("Escribe un nombre de categoría.".to_string());
    }

    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    if nombre_actual == nombre_nuevo {
        return listar_categorias(conn).await.map_err(|e| e.to_string());
    }

    let tx = conn.transaction().await.map_err(|e| e.to_string())?;
    let cambiadas = tx
        .execute(
            "UPDATE categorias SET nombre = ?1 WHERE nombre = ?2",
            params![nombre_nuevo.as_str(), nombre_actual.as_str()],
        )
        .await
        .map_err(|e| {
            if es_duplicado(&e) {
                "Ya existe una categoría con ese nombre.".to_string()
            } else {
                e.to_string()
            }
        })?;
    if cambiadas == 0 {
        return Err("La categoría no existe.".to_string());
    }
    tx.execute(
        "UPDATE productos SET categoria = ?1 WHERE categoria = ?2",
        params![nombre_nuevo, nombre_actual],
    )
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;

    listar_categorias(conn).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn eliminar_categoria(
    state: tauri::State<'_, AppState>,
    nombre: String,
) -> Result<Vec<String>, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    // Los productos guardan el nombre de la categoría como texto: si se borrara una en uso, esos
    // productos quedarían con una categoría que ya no aparece en los filtros ni en el formulario.
    let en_uso: i64 = fila(
        conn,
        "SELECT COUNT(*) FROM productos WHERE categoria = ?1",
        params![nombre.as_str()],
        |row| row.col(0),
    )
    .await
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
        .await
        .map_err(|e| e.to_string())?;

    listar_categorias(conn).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn obtener_productos(
    state: tauri::State<'_, AppState>,
    pagina: i64,
    busqueda: Option<String>,
    categoria_filtro: Option<String>,
) -> Result<PaginaProductos, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    listar_pagina(conn, pagina, &busqueda, &categoria_filtro, &None, "id DESC")
        .await
        .map_err(|e| e.to_string())
}

// Vista de solo lectura para Inventario: mismo listado paginado/filtrado, pero ordenado por menor
// stock primero, para detectar rápido qué está bajo o sin stock.
#[tauri::command]
async fn obtener_inventario(
    state: tauri::State<'_, AppState>,
    pagina: i64,
    busqueda: Option<String>,
    categoria_filtro: Option<String>,
    estado_stock: Option<String>,
) -> Result<PaginaProductos, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    listar_pagina(conn, pagina, &busqueda, &categoria_filtro, &estado_stock, "stock ASC, id DESC")
        .await
        .map_err(|e| e.to_string())
}

// Stock actual del producto, o None si ya no existe.
async fn obtener_stock_actual(conn: &Connection, id: i64) -> libsql::Result<Option<i32>> {
    una_fila(conn, "SELECT stock FROM productos WHERE id = ?1", params![id], |row| row.col(0)).await
}

// Deja constancia del movimiento (entrada o salida) en el historial de stock del producto.
async fn registrar_movimiento(
    conn: &Connection,
    producto_id: i64,
    tipo: &str,
    cantidad: i32,
    stock_resultante: i32,
) -> libsql::Result<()> {
    conn.execute(
        "INSERT INTO movimientos_stock (producto_id, tipo, cantidad, stock_resultante, fecha)
         VALUES (?1, ?2, ?3, ?4, datetime('now', 'localtime'))",
        params![producto_id, tipo, cantidad, stock_resultante],
    )
    .await?;
    Ok(())
}

// Suma stock a un producto existente (p. ej. al recibir mercadería), sin pasar por el formulario
// completo de edición.
#[tauri::command]
async fn agregar_stock(
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

    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    // Stock y movimiento juntos: o se guardan los dos o ninguno.
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;
    let stock_actual = obtener_stock_actual(&tx, id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "El producto ya no existe.".to_string())?;
    let stock_resultante = stock_actual
        .checked_add(cantidad)
        .ok_or_else(|| "La cantidad es demasiado grande.".to_string())?;
    tx.execute(
        "UPDATE productos SET stock = ?1 WHERE id = ?2",
        params![stock_resultante, id],
    )
    .await
    .map_err(|e| e.to_string())?;
    registrar_movimiento(&tx, id, "ENTRADA", cantidad, stock_resultante)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;

    listar_pagina(conn, pagina, &busqueda, &categoria_filtro, &estado_stock, "stock ASC, id DESC")
        .await
        .map_err(|e| e.to_string())
}

// Resta stock de un producto existente (p. ej. una venta o un ajuste). No permite bajar de 0.
#[tauri::command]
async fn quitar_stock(
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

    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    let stock_actual = obtener_stock_actual(&tx, id)
        .await
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
    .await
    .map_err(|e| e.to_string())?;
    registrar_movimiento(&tx, id, "SALIDA", cantidad, stock_resultante)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;

    listar_pagina(conn, pagina, &busqueda, &categoria_filtro, &estado_stock, "stock ASC, id DESC")
        .await
        .map_err(|e| e.to_string())
}

// Historial de movimientos de un producto, más recientes primero.
#[tauri::command]
async fn obtener_movimientos(
    state: tauri::State<'_, AppState>,
    producto_id: i64,
) -> Result<Vec<Movimiento>, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;

    filas(
        conn,
        "SELECT id, tipo, cantidad, stock_resultante, fecha
         FROM movimientos_stock WHERE producto_id = ?1 ORDER BY id DESC",
        params![producto_id],
        |row| {
            Ok(Movimiento {
                id: row.col(0)?,
                tipo: row.col(1)?,
                cantidad: row.col(2)?,
                stock_resultante: row.col(3)?,
                fecha: row.col(4)?,
            })
        },
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn agregar_producto(
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

    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    // El stock inicial siempre es 0: se gestiona exclusivamente desde Inventario.
    conn.execute(
        "INSERT INTO productos (codigo, detalle, categoria, precio, iva, stock, medida, aplicacion)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
        params![codigo, detalle, categoria, precio, iva, medida, aplicacion],
    )
    .await
    .map_err(mapear_error_guardado)?;

    // El producto nuevo queda primero (orden por id descendente), así que mostramos la página 1
    // respetando los filtros que el usuario tenga activos.
    listar_pagina(conn, 1, &busqueda, &categoria_filtro, &None, "id DESC")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn actualizar_producto(
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

    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    // El stock no se toca aquí: se gestiona exclusivamente desde Inventario.
    conn.execute(
        "UPDATE productos SET codigo = ?1, detalle = ?2, categoria = ?3, precio = ?4, iva = ?5,
                medida = COALESCE(?7, medida), aplicacion = COALESCE(?8, aplicacion)
         WHERE id = ?6",
        params![codigo, detalle, categoria, precio, iva, id, medida, aplicacion],
    )
    .await
    .map_err(mapear_error_guardado)?;

    listar_pagina(conn, pagina, &busqueda, &categoria_filtro, &None, "id DESC")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn eliminar_producto(
    state: tauri::State<'_, AppState>,
    id: i64,
    pagina: i64,
    busqueda: Option<String>,
    categoria_filtro: Option<String>,
) -> Result<PaginaProductos, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM movimientos_stock WHERE producto_id = ?1",
        params![id],
    )
    .await
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM productos WHERE id = ?1", params![id])
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;

    listar_pagina(conn, pagina, &busqueda, &categoria_filtro, &None, "id DESC")
        .await
        .map_err(|e| e.to_string())
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

fn mapear_venta(row: &Row) -> libsql::Result<Venta> {
    Ok(Venta {
        id: row.col(0)?,
        fecha: row.col(1)?,
        subtotal_cero: row.col(2)?,
        subtotal_iva5: row.col(3)?,
        subtotal_iva15: row.col(4)?,
        iva5: row.col(5)?,
        iva15: row.col(6)?,
        total: row.col(7)?,
        pago: row.col(8)?,
        cambio: row.col(9)?,
        unidades: row.col(10)?,
        descuento: row.col(11)?,
        cliente_nombre: row.col(12)?,
        cliente_identificacion: row.col(13)?,
        total_devuelto: redondear_monto(row.col(14)?),
        credito: row.col(15)?,
        devolucion_id: row.col(16)?,
    })
}

// Búsqueda rápida para el punto de venta: por código o detalle, con la coincidencia exacta de
// código primero (útil con lector de código de barras). Sin texto, muestra los primeros productos.
#[tauri::command]
async fn buscar_productos_venta(
    state: tauri::State<'_, AppState>,
    busqueda: Option<String>,
) -> Result<Vec<Producto>, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;

    let texto = busqueda
        .as_deref()
        .map(|t| t.trim().to_uppercase())
        .unwrap_or_default();

    // Palabras sueltas en cualquier orden; el código exacto (lector de barras) va primero.
    let (clausula, mut valores) = construir_filtro(&busqueda, &None, &None);
    valores.push((":texto", Value::Text(texto)));
    valores.push((":limite", Value::Integer(RESULTADOS_BUSQUEDA_VENTA)));

    let sql = format!(
        "SELECT {} FROM productos {}
         ORDER BY CASE WHEN codigo = :texto THEN 0 ELSE 1 END, detalle
         LIMIT :limite",
        COLUMNAS_PRODUCTO, clausula
    );
    filas(conn, &sql, con_nombre(&valores), mapear_producto)
        .await
        .map_err(|e| e.to_string())
}

// Datos actuales de los productos que están en las ventas abiertas (precio, stock, detalle...).
// Las ventas abiertas guardan una copia del producto del momento en que se agregó; con esto se
// refresca al volver a la pantalla de venta. Los que ya no existen simplemente no vienen.
const MAX_PRODUCTOS_REFRESCO: usize = 500;

#[tauri::command]
async fn obtener_productos_por_ids(
    state: tauri::State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<Vec<Producto>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    if ids.len() > MAX_PRODUCTOS_REFRESCO {
        return Err("Demasiados productos.".to_string());
    }
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    let marcadores = vec!["?"; ids.len()].join(", ");
    let sql = format!("SELECT {} FROM productos WHERE id IN ({})", COLUMNAS_PRODUCTO, marcadores);
    filas(conn, &sql, libsql::params_from_iter(ids), mapear_producto)
        .await
        .map_err(|e| e.to_string())
}

// Registra una venta completa en una sola transacción: valida stock, calcula importes con los
// precios actuales de la base (no con los que manda el frontend), descuenta stock y deja el
// movimiento en el historial de cada producto. Si algo falla, no se guarda nada.
#[tauri::command]
async fn registrar_venta(
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

    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    // Cliente opcional: si viene, debe existir. Se guarda una copia de su nombre e identificación.
    let cliente: Option<(i64, String, String)> = match cliente_id {
        None => None,
        Some(id) => {
            let encontrado = una_fila(
                &tx,
                "SELECT id, nombre, identificacion FROM clientes WHERE id = ?1",
                params![id],
                |row| Ok((row.col(0)?, row.col(1)?, row.col(2)?)),
            )
            .await
            .map_err(|e| e.to_string())?;
            match encontrado {
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
        let producto = una_fila(
            &tx,
            "SELECT codigo, detalle, precio, iva, stock, medida FROM productos WHERE id = ?1",
            params![producto_id],
            |row| {
                Ok((
                    row.col::<String>(0)?,
                    row.col::<String>(1)?,
                    row.col::<f64>(2)?,
                    row.col::<String>(3)?,
                    row.col::<i32>(4)?,
                    row.col::<String>(5)?,
                ))
            },
        )
        .await
        .map_err(|e| e.to_string())?;

        let Some((codigo, detalle, precio, iva, stock, medida)) = producto else {
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
        Some(id) => credito_disponible(&tx, id).await?,
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
    .await
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
                linea.codigo.as_str(),
                linea.detalle.as_str(),
                linea.cantidad,
                de_centavos(linea.precio_centavos),
                linea.iva.as_str(),
                de_centavos(linea.subtotal_centavos),
                linea.medida.as_str(),
                de_centavos(linea.precio_lista_centavos),
                linea.descuento_pct,
                de_centavos(linea.descuento_centavos),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        tx.execute(
            "UPDATE productos SET stock = stock - ?1 WHERE id = ?2",
            params![linea.cantidad, linea.producto_id],
        )
        .await
        .map_err(|e| e.to_string())?;

        registrar_movimiento(&tx, linea.producto_id, "VENTA", linea.cantidad, linea.stock - linea.cantidad)
            .await
            .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    fila(conn, &format!("{} WHERE v.id = ?1", SELECT_VENTA), params![venta_id], mapear_venta)
        .await
        .map_err(|e| e.to_string())
}

// Historial de ventas paginado (más recientes primero), con el resumen del día.
#[tauri::command]
async fn obtener_ventas(state: tauri::State<'_, AppState>, pagina: i64) -> Result<PaginaVentas, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;

    let total: i64 = fila(conn, "SELECT COUNT(*) FROM ventas", (), |row| row.col(0))
        .await
        .map_err(|e| e.to_string())?;
    let total_paginas = ((total as f64) / (VENTAS_POR_PAGINA as f64)).ceil().max(1.0) as i64;
    let pagina = pagina.clamp(1, total_paginas);
    let offset = (pagina - 1) * VENTAS_POR_PAGINA;

    let ventas = filas(
        conn,
        &format!("{} ORDER BY v.id DESC LIMIT ?1 OFFSET ?2", SELECT_VENTA),
        params![VENTAS_POR_PAGINA, offset],
        mapear_venta,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Monto neto del día: ventas menos devoluciones hechas hoy.
    let (ventas_hoy, monto_hoy): (i64, f64) = fila(
        conn,
        "SELECT COUNT(*), COALESCE(SUM(total), 0)
                - (SELECT COALESCE(SUM(total), 0) FROM devoluciones
                   WHERE date(fecha) = date('now', 'localtime'))
         FROM ventas
         WHERE date(fecha) = date('now', 'localtime')",
        (),
        |row| Ok((row.col(0)?, row.col(1)?)),
    )
    .await
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
async fn obtener_detalle_venta(
    state: tauri::State<'_, AppState>,
    venta_id: i64,
) -> Result<Vec<DetalleVenta>, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;

    filas(
        conn,
        "SELECT d.id, d.codigo, d.detalle, d.cantidad, d.precio_unitario, d.iva, d.subtotal, d.medida,
                d.precio_lista, d.descuento_pct, d.descuento,
                (SELECT COALESCE(SUM(dd.cantidad), 0) FROM devolucion_detalle dd WHERE dd.venta_detalle_id = d.id)
         FROM venta_detalle d WHERE d.venta_id = ?1 ORDER BY d.id",
        params![venta_id],
        |row| {
            Ok(DetalleVenta {
                id: row.col(0)?,
                codigo: row.col(1)?,
                detalle: row.col(2)?,
                cantidad: row.col(3)?,
                precio_unitario: row.col(4)?,
                iva: row.col(5)?,
                subtotal: row.col(6)?,
                medida: row.col(7)?,
                precio_lista: row.col(8)?,
                descuento_pct: row.col(9)?,
                descuento: row.col(10)?,
                devuelto: row.col(11)?,
            })
        },
    )
    .await
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

fn mapear_devolucion(row: &Row) -> libsql::Result<Devolucion> {
    Ok(Devolucion {
        id: row.col(0)?,
        venta_id: row.col(1)?,
        fecha: row.col(2)?,
        motivo: row.col(3)?,
        reembolso: row.col(4)?,
        subtotal_cero: row.col(5)?,
        subtotal_iva5: row.col(6)?,
        subtotal_iva15: row.col(7)?,
        iva5: row.col(8)?,
        iva15: row.col(9)?,
        total: row.col(10)?,
        unidades: row.col(11)?,
        usada_en_venta: row.col(12)?,
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
async fn credito_disponible(conn: &Connection, devolucion_id: i64) -> Result<i64, String> {
    let encontrada = una_fila(
        conn,
        &format!("{} WHERE d.id = ?1", SELECT_DEVOLUCION),
        params![devolucion_id],
        mapear_devolucion,
    )
    .await
    .map_err(|e| e.to_string())?;
    let Some(dev) = encontrada else {
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
async fn registrar_devolucion(
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

    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;

    let existe: bool = fila(&tx, "SELECT COUNT(*) > 0 FROM ventas WHERE id = ?1", params![venta_id], |row| {
        row.col(0)
    })
    .await
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
        let linea_venta = una_fila(
            &tx,
            "SELECT d.producto_id, d.codigo, d.detalle, d.cantidad, d.precio_unitario, d.iva, d.subtotal,
                    (SELECT COALESCE(SUM(dd.cantidad), 0) FROM devolucion_detalle dd WHERE dd.venta_detalle_id = d.id)
             FROM venta_detalle d WHERE d.id = ?1 AND d.venta_id = ?2",
            params![item.venta_detalle_id, venta_id],
            |row| {
                Ok((
                    row.col::<i64>(0)?,
                    row.col::<String>(1)?,
                    row.col::<String>(2)?,
                    row.col::<i32>(3)?,
                    row.col::<f64>(4)?,
                    row.col::<String>(5)?,
                    row.col::<f64>(6)?,
                    row.col::<i32>(7)?,
                ))
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        let Some((producto_id, codigo, detalle, vendida, precio_unitario, iva, subtotal, devuelta)) = linea_venta
        else {
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
            let existe_producto: bool =
                fila(&tx, "SELECT COUNT(*) > 0 FROM productos WHERE id = ?1", params![producto_id], |row| {
                    row.col(0)
                })
                .await
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
    let (prev_base5, prev_iva5, prev_base15, prev_iva15): (f64, f64, f64, f64) = fila(
        &tx,
        "SELECT COALESCE(SUM(subtotal_iva5), 0), COALESCE(SUM(iva5), 0),
                COALESCE(SUM(subtotal_iva15), 0), COALESCE(SUM(iva15), 0)
         FROM devoluciones WHERE venta_id = ?1",
        params![venta_id],
        |row| Ok((row.col(0)?, row.col(1)?, row.col(2)?, row.col(3)?)),
    )
    .await
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
    .await
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
                linea.codigo.as_str(),
                linea.detalle.as_str(),
                linea.cantidad,
                linea.precio_unitario,
                linea.iva.as_str(),
                de_centavos(linea.subtotal_centavos),
                linea.regresa_stock,
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        if linea.regresa_stock {
            tx.execute(
                "UPDATE productos SET stock = stock + ?1 WHERE id = ?2",
                params![linea.cantidad, linea.producto_id],
            )
            .await
            .map_err(|e| e.to_string())?;
            let stock_resultante = obtener_stock_actual(&tx, linea.producto_id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("{} ya no existe en el catálogo.", linea.detalle))?;
            registrar_movimiento(&tx, linea.producto_id, "DEVOLUCION", linea.cantidad, stock_resultante)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    fila(conn, &format!("{} WHERE d.id = ?1", SELECT_DEVOLUCION), params![devolucion_id], mapear_devolucion)
        .await
        .map_err(|e| e.to_string())
}

// Devoluciones de una venta, más antiguas primero.
#[tauri::command]
async fn obtener_devoluciones_venta(
    state: tauri::State<'_, AppState>,
    venta_id: i64,
) -> Result<Vec<Devolucion>, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    filas(
        conn,
        &format!("{} WHERE d.venta_id = ?1 ORDER BY d.id", SELECT_DEVOLUCION),
        params![venta_id],
        mapear_devolucion,
    )
    .await
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

async fn resumen_inventario(conn: &Connection) -> libsql::Result<ResumenInventario> {
    fila(
        conn,
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN stock > 0 AND stock <= ?1 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN stock > 0 THEN stock ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN stock > 0 THEN precio * stock ELSE 0 END), 0)
         FROM productos",
        params![UMBRAL_STOCK_BAJO],
        |row| {
            Ok(ResumenInventario {
                total_productos: row.col(0)?,
                productos_sin_stock: row.col(1)?,
                productos_stock_bajo: row.col(2)?,
                unidades_en_stock: row.col(3)?,
                valor_inventario: redondear_monto(row.col(4)?),
            })
        },
    )
    .await
}

#[tauri::command]
async fn obtener_resumen_inventario(state: tauri::State<'_, AppState>) -> Result<ResumenInventario, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    resumen_inventario(conn).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn obtener_resumen_panel(state: tauri::State<'_, AppState>) -> Result<ResumenPanel, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    resumen_panel(conn).await.map_err(|e| e.to_string())
}

async fn resumen_panel(conn: &Connection) -> libsql::Result<ResumenPanel> {
    let ResumenInventario {
        total_productos,
        productos_sin_stock,
        productos_stock_bajo,
        unidades_en_stock,
        valor_inventario,
    } = resumen_inventario(conn).await?;

    // Un registro por cada uno de los últimos N días, incluidos los días sin ventas (en 0).
    let ventas_por_dia = filas(
        conn,
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
        params![format!("-{} days", DIAS_GRAFICO_VENTAS - 1)],
        |row| {
            Ok(VentasDia {
                fecha: row.col(0)?,
                total: redondear_monto(row.col(1)?),
                cantidad: row.col(2)?,
            })
        },
    )
    .await?;

    let mas_vendidos = filas(
        conn,
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
        (),
        |row| {
            Ok(ProductoVendido {
                codigo: row.col(0)?,
                detalle: row.col(1)?,
                unidades: row.col(2)?,
                monto: redondear_monto(row.col(3)?),
            })
        },
    )
    .await?;

    let alertas_stock = filas(
        conn,
        "SELECT id, codigo, detalle, stock FROM productos
         WHERE stock <= ?1 ORDER BY stock ASC, detalle LIMIT 8",
        params![UMBRAL_STOCK_BAJO],
        |row| {
            Ok(ProductoAlerta {
                id: row.col(0)?,
                codigo: row.col(1)?,
                detalle: row.col(2)?,
                stock: row.col(3)?,
            })
        },
    )
    .await?;

    let ultimas_ventas =
        filas(conn, &format!("{} ORDER BY v.id DESC LIMIT 5", SELECT_VENTA), (), mapear_venta).await?;

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

fn mapear_error_cliente(err: libsql::Error) -> String {
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

fn mapear_cliente(row: &Row) -> libsql::Result<Cliente> {
    let total: f64 = row.col(9)?;
    Ok(Cliente {
        id: row.col(0)?,
        tipo_identificacion: row.col(1)?,
        identificacion: row.col(2)?,
        nombre: row.col(3)?,
        telefono: row.col(4)?,
        email: row.col(5)?,
        direccion: row.col(6)?,
        fecha_registro: row.col(7)?,
        compras: row.col(8)?,
        total_comprado: de_centavos(a_centavos(total)),
        ultima_compra: row.col(10)?,
    })
}

async fn obtener_cliente(conn: &Connection, id: i64) -> libsql::Result<Cliente> {
    fila(
        conn,
        &format!("{} WHERE c.id = ?1 GROUP BY c.id", SELECT_CLIENTE),
        params![id],
        mapear_cliente,
    )
    .await
}

#[tauri::command]
async fn obtener_clientes(
    state: tauri::State<'_, AppState>,
    pagina: i64,
    busqueda: Option<String>,
) -> Result<PaginaClientes, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;

    let (filtro, mut valores) = filtro_cliente(busqueda.as_deref().unwrap_or(""));

    let total: i64 = fila(
        conn,
        &format!("SELECT COUNT(*) FROM clientes c {}", filtro),
        con_nombre(&valores),
        |row| row.col(0),
    )
    .await
    .map_err(|e| e.to_string())?;
    let total_paginas = ((total as f64) / (CLIENTES_POR_PAGINA as f64)).ceil().max(1.0) as i64;
    let pagina = pagina.clamp(1, total_paginas);
    let offset = (pagina - 1) * CLIENTES_POR_PAGINA;

    valores.push((":limite", Value::Integer(CLIENTES_POR_PAGINA)));
    valores.push((":offset", Value::Integer(offset)));
    let sql = format!(
        "{} {} GROUP BY c.id ORDER BY c.nombre LIMIT :limite OFFSET :offset",
        SELECT_CLIENTE, filtro
    );
    let clientes = filas(conn, &sql, con_nombre(&valores), mapear_cliente)
        .await
        .map_err(|e| e.to_string())?;

    Ok(PaginaClientes { clientes, total, pagina })
}

// Búsqueda rápida para elegir el cliente en una venta (identificación exacta primero).
#[tauri::command]
async fn buscar_clientes(state: tauri::State<'_, AppState>, busqueda: String) -> Result<Vec<Cliente>, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;

    let (filtro, mut valores) = filtro_cliente(&busqueda);
    valores.push((":texto", Value::Text(busqueda.trim().to_uppercase())));
    valores.push((":limite", Value::Integer(RESULTADOS_BUSQUEDA_CLIENTE)));
    let sql = format!(
        "{} {} GROUP BY c.id
         ORDER BY CASE WHEN c.identificacion = :texto THEN 0 ELSE 1 END, c.nombre
         LIMIT :limite",
        SELECT_CLIENTE, filtro
    );
    filas(conn, &sql, con_nombre(&valores), mapear_cliente)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn agregar_cliente(
    state: tauri::State<'_, AppState>,
    tipo_identificacion: String,
    identificacion: String,
    nombre: String,
    telefono: Option<String>,
    email: Option<String>,
    direccion: Option<String>,
) -> Result<Cliente, String> {
    let d = preparar_cliente(tipo_identificacion, identificacion, nombre, telefono, email, direccion)?;
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    conn.execute(
        "INSERT INTO clientes (tipo_identificacion, identificacion, nombre, telefono, email, direccion, fecha_registro)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', 'localtime'))",
        params![d.tipo_identificacion, d.identificacion, d.nombre, d.telefono, d.email, d.direccion],
    )
    .await
    .map_err(mapear_error_cliente)?;
    obtener_cliente(conn, conn.last_insert_rowid()).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn actualizar_cliente(
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
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    conn.execute(
        "UPDATE clientes SET tipo_identificacion = ?1, identificacion = ?2, nombre = ?3, telefono = ?4,
                email = ?5, direccion = ?6
         WHERE id = ?7",
        params![d.tipo_identificacion, d.identificacion, d.nombre, d.telefono, d.email, d.direccion, id],
    )
    .await
    .map_err(mapear_error_cliente)?;
    obtener_cliente(conn, id).await.map_err(|e| e.to_string())
}

// Elimina el cliente. Sus ventas se conservan (con la copia del nombre guardada en cada venta).
#[tauri::command]
async fn eliminar_cliente(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    let tx = conn.transaction().await.map_err(|e| e.to_string())?;
    tx.execute("UPDATE ventas SET cliente_id = NULL WHERE cliente_id = ?1", params![id])
        .await
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM clientes WHERE id = ?1", params![id])
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())
}

// Compras de un cliente, más recientes primero.
#[tauri::command]
async fn obtener_ventas_cliente(
    state: tauri::State<'_, AppState>,
    cliente_id: i64,
) -> Result<Vec<Venta>, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    filas(
        conn,
        &format!("{} WHERE v.cliente_id = ?1 ORDER BY v.id DESC LIMIT 100", SELECT_VENTA),
        params![cliente_id],
        mapear_venta,
    )
    .await
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
            let base = buscar_base_existente(&dir).map(|ruta| {
                tauri::async_runtime::block_on(abrir_base_de_datos(ruta))
                    .expect("no se pudo abrir la base de datos SQLite")
            });

            app.manage(AppState {
                db: Mutex::new(base),
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
