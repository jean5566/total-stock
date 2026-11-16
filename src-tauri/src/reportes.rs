// ---------------------------------------------------------------------------------------------
// Reportes: todo lo de un rango de fechas (ambos días incluidos) en una sola consulta al backend.
//
// Criterio contable: cada documento cuenta en la fecha en que se hizo. Las ventas cuentan el día
// de la venta y las devoluciones el día de la devolución (aunque la venta original sea de otro
// período). Así los totales cuadran con el panel principal y con la caja de cada día.
// ---------------------------------------------------------------------------------------------

use std::collections::HashMap;

use libsql::{params, Connection, Row};
use rust_xlsxwriter::{Color, Format, FormatBorder, Workbook, XlsxError};
use serde::{Deserialize, Serialize};

use super::db::{fila, filas, FilaExt};
use super::{a_centavos, de_centavos, requerir_conexion, sanear_nombre_archivo, AppState};

// Rangos de más de estos días se agrupan por mes en el gráfico y en los impuestos.
const MAX_DIAS_AGRUPAR_POR_DIA: i64 = 62;
const MAX_DIAS_RANGO: i64 = 3700;
const MAX_FILAS_DEVOLUCIONES: i64 = 1000;
const MAX_FILAS_EXCEL: usize = 500_000;

fn monto(valor: f64) -> f64 {
    de_centavos(a_centavos(valor))
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResumenReporte {
    ventas: i64,
    ventas_brutas: f64,
    descuentos: f64,
    unidades: i64,
    devoluciones: i64,
    monto_devuelto: f64,
    unidades_devueltas: i64,
    ventas_netas: f64,
    ticket_promedio: f64,
    clientes: i64,
    // Caja: lo cobrado (sin el crédito de cambios aplicado) y lo reembolsado en efectivo.
    cobrado: f64,
    credito_aplicado: f64,
    reembolsado_efectivo: f64,
}

#[derive(Serialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Desglose {
    subtotal_cero: f64,
    subtotal_iva5: f64,
    subtotal_iva15: f64,
    iva5: f64,
    iva15: f64,
    total: f64,
}

impl Desglose {
    fn restar(&self, otro: &Desglose) -> Desglose {
        let r = |a: f64, b: f64| de_centavos(a_centavos(a) - a_centavos(b));
        Desglose {
            subtotal_cero: r(self.subtotal_cero, otro.subtotal_cero),
            subtotal_iva5: r(self.subtotal_iva5, otro.subtotal_iva5),
            subtotal_iva15: r(self.subtotal_iva15, otro.subtotal_iva15),
            iva5: r(self.iva5, otro.iva5),
            iva15: r(self.iva15, otro.iva15),
            total: r(self.total, otro.total),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PuntoSerie {
    // AAAA-MM-DD (por día) o AAAA-MM (por mes)
    periodo: String,
    ventas: i64,
    ventas_brutas: f64,
    devoluciones: f64,
    // Neto (ventas − devoluciones) desglosado por tarifa de IVA
    neto: Desglose,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Distribucion {
    // Hora 0–23 o día de la semana 0–6 (0 = domingo)
    clave: i64,
    ventas: i64,
    monto: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReporteProducto {
    codigo: String,
    detalle: String,
    categoria: String,
    ventas: i64,
    unidades_vendidas: i64,
    unidades_devueltas: i64,
    // Sin IVA, después de descuentos y devoluciones
    monto_neto: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReporteCliente {
    nombre: String,
    identificacion: String,
    compras: i64,
    total_compras: f64,
    devoluciones: f64,
    neto: f64,
    ultima_compra: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReporteDevolucion {
    id: i64,
    venta_id: i64,
    fecha: String,
    motivo: String,
    reembolso: String,
    cliente_nombre: String,
    unidades: i64,
    total: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reporte {
    desde: String,
    hasta: String,
    anterior_desde: String,
    anterior_hasta: String,
    // "dia" o "mes"
    agrupacion: String,
    resumen: ResumenReporte,
    anterior: ResumenReporte,
    serie: Vec<PuntoSerie>,
    por_hora: Vec<Distribucion>,
    por_dia_semana: Vec<Distribucion>,
    productos: Vec<ReporteProducto>,
    clientes: Vec<ReporteCliente>,
    impuestos_ventas: Desglose,
    impuestos_devoluciones: Desglose,
    impuestos_neto: Desglose,
    devoluciones: Vec<ReporteDevolucion>,
}

#[tauri::command]
pub async fn obtener_reporte(
    state: tauri::State<'_, AppState>,
    desde: String,
    hasta: String,
) -> Result<Reporte, String> {
    let guard = state.db.lock().await;
    let conn = requerir_conexion(&guard)?;
    validar_rango(conn, &desde, &hasta).await?;
    construir_reporte(conn, &desde, &hasta).await.map_err(|e| e.to_string())
}

// Fechas AAAA-MM-DD válidas, desde <= hasta y un rango razonable.
async fn validar_rango(conn: &Connection, desde: &str, hasta: &str) -> Result<(), String> {
    let (ok_desde, ok_hasta, dias): (bool, bool, Option<f64>) = fila(
        conn,
        "SELECT date(?1) IS ?1, date(?2) IS ?2, julianday(?2) - julianday(?1)",
        params![desde, hasta],
        |row| Ok((row.col(0)?, row.col(1)?, row.col(2)?)),
    )
    .await
    .map_err(|e| e.to_string())?;
    if !ok_desde || !ok_hasta {
        return Err("Las fechas del reporte no son válidas.".to_string());
    }
    match dias {
        Some(d) if d < 0.0 => Err("La fecha inicial no puede ser posterior a la final.".to_string()),
        Some(d) if d as i64 > MAX_DIAS_RANGO => Err("El rango máximo de un reporte es de 10 años.".to_string()),
        _ => Ok(()),
    }
}

async fn construir_reporte(conn: &Connection, desde: &str, hasta: &str) -> libsql::Result<Reporte> {
    // Período anterior de la misma duración, justo antes del actual.
    let (dias, anterior_desde, anterior_hasta): (i64, String, String) = fila(
        conn,
        "SELECT CAST(julianday(?2) - julianday(?1) AS INTEGER) + 1,
                date(?1, printf('-%d days', CAST(julianday(?2) - julianday(?1) AS INTEGER) + 1)),
                date(?1, '-1 day')",
        params![desde, hasta],
        |row| Ok((row.col(0)?, row.col(1)?, row.col(2)?)),
    )
    .await?;
    let por_mes = dias > MAX_DIAS_AGRUPAR_POR_DIA;

    let impuestos_ventas = desglose(
        conn,
        "SELECT COALESCE(SUM(subtotal_cero), 0), COALESCE(SUM(subtotal_iva5), 0), COALESCE(SUM(subtotal_iva15), 0),
                COALESCE(SUM(iva5), 0), COALESCE(SUM(iva15), 0), COALESCE(SUM(total), 0)
         FROM ventas WHERE date(fecha) BETWEEN ?1 AND ?2",
        desde,
        hasta,
    )
    .await?;
    let impuestos_devoluciones = desglose(
        conn,
        "SELECT COALESCE(SUM(subtotal_cero), 0), COALESCE(SUM(subtotal_iva5), 0), COALESCE(SUM(subtotal_iva15), 0),
                COALESCE(SUM(iva5), 0), COALESCE(SUM(iva15), 0), COALESCE(SUM(total), 0)
         FROM devoluciones WHERE date(fecha) BETWEEN ?1 AND ?2",
        desde,
        hasta,
    )
    .await?;

    Ok(Reporte {
        desde: desde.to_string(),
        hasta: hasta.to_string(),
        resumen: resumen(conn, desde, hasta).await?,
        anterior: resumen(conn, &anterior_desde, &anterior_hasta).await?,
        anterior_desde,
        anterior_hasta,
        agrupacion: if por_mes { "mes" } else { "dia" }.to_string(),
        serie: serie(conn, desde, hasta, por_mes).await?,
        por_hora: distribucion(conn, desde, hasta, "%H").await?,
        por_dia_semana: distribucion(conn, desde, hasta, "%w").await?,
        productos: productos(conn, desde, hasta).await?,
        clientes: clientes(conn, desde, hasta).await?,
        impuestos_neto: impuestos_ventas.restar(&impuestos_devoluciones),
        impuestos_ventas,
        impuestos_devoluciones,
        devoluciones: devoluciones(conn, desde, hasta).await?,
    })
}

fn mapear_desglose(row: &Row, desde_columna: i32) -> libsql::Result<Desglose> {
    let c = desde_columna;
    Ok(Desglose {
        subtotal_cero: monto(row.col(c)?),
        subtotal_iva5: monto(row.col(c + 1)?),
        subtotal_iva15: monto(row.col(c + 2)?),
        iva5: monto(row.col(c + 3)?),
        iva15: monto(row.col(c + 4)?),
        total: monto(row.col(c + 5)?),
    })
}

async fn desglose(conn: &Connection, sql: &str, desde: &str, hasta: &str) -> libsql::Result<Desglose> {
    fila(conn, sql, params![desde, hasta], |row| mapear_desglose(row, 0)).await
}

async fn resumen(conn: &Connection, desde: &str, hasta: &str) -> libsql::Result<ResumenReporte> {
    let (ventas, ventas_brutas, descuentos, credito_aplicado, clientes): (i64, f64, f64, f64, i64) = fila(
        conn,
        "SELECT COUNT(*), COALESCE(SUM(total), 0), COALESCE(SUM(descuento), 0), COALESCE(SUM(credito), 0),
                COUNT(DISTINCT cliente_id)
         FROM ventas WHERE date(fecha) BETWEEN ?1 AND ?2",
        params![desde, hasta],
        |row| Ok((row.col(0)?, row.col(1)?, row.col(2)?, row.col(3)?, row.col(4)?)),
    )
    .await?;
    let unidades: i64 = fila(
        conn,
        "SELECT COALESCE(SUM(d.cantidad), 0) FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
         WHERE date(v.fecha) BETWEEN ?1 AND ?2",
        params![desde, hasta],
        |row| row.col(0),
    )
    .await?;
    let (devoluciones, monto_devuelto, reembolsado_efectivo): (i64, f64, f64) = fila(
        conn,
        "SELECT COUNT(*), COALESCE(SUM(total), 0),
                COALESCE(SUM(CASE WHEN reembolso = 'EFECTIVO' THEN total ELSE 0 END), 0)
         FROM devoluciones WHERE date(fecha) BETWEEN ?1 AND ?2",
        params![desde, hasta],
        |row| Ok((row.col(0)?, row.col(1)?, row.col(2)?)),
    )
    .await?;
    let unidades_devueltas: i64 = fila(
        conn,
        "SELECT COALESCE(SUM(dd.cantidad), 0) FROM devolucion_detalle dd
         JOIN devoluciones dv ON dv.id = dd.devolucion_id
         WHERE date(dv.fecha) BETWEEN ?1 AND ?2",
        params![desde, hasta],
        |row| row.col(0),
    )
    .await?;

    let brutas = a_centavos(ventas_brutas);
    let netas = brutas - a_centavos(monto_devuelto);
    Ok(ResumenReporte {
        ventas,
        ventas_brutas: de_centavos(brutas),
        descuentos: monto(descuentos),
        unidades,
        devoluciones,
        monto_devuelto: monto(monto_devuelto),
        unidades_devueltas,
        ventas_netas: de_centavos(netas),
        ticket_promedio: if ventas > 0 { de_centavos((brutas as f64 / ventas as f64).round() as i64) } else { 0.0 },
        clientes,
        cobrado: de_centavos(brutas - a_centavos(credito_aplicado)),
        credito_aplicado: monto(credito_aplicado),
        reembolsado_efectivo: monto(reembolsado_efectivo),
    })
}

// Un punto por cada día (o mes) del rango, incluidos los que no tuvieron movimiento.
async fn serie(conn: &Connection, desde: &str, hasta: &str, por_mes: bool) -> libsql::Result<Vec<PuntoSerie>> {
    let (claves_sql, formato) = if por_mes {
        (
            "WITH RECURSIVE k(d) AS (
                 SELECT date(?1, 'start of month')
                 UNION ALL SELECT date(d, '+1 month') FROM k WHERE d < date(?2, 'start of month')
             ) SELECT strftime('%Y-%m', d) FROM k",
            "%Y-%m",
        )
    } else {
        (
            "WITH RECURSIVE k(d) AS (
                 SELECT date(?1) UNION ALL SELECT date(d, '+1 day') FROM k WHERE d < date(?2)
             ) SELECT d FROM k",
            "%Y-%m-%d",
        )
    };
    let claves: Vec<String> = filas(conn, claves_sql, params![desde, hasta], |row| row.col(0)).await?;

    // (cantidad de ventas, desglose) por período, de ventas y de devoluciones
    let agrupar = async |tabla: &str| -> libsql::Result<HashMap<String, (i64, Desglose)>> {
        let sql = format!(
            "SELECT strftime('{formato}', fecha), COUNT(*),
                    SUM(subtotal_cero), SUM(subtotal_iva5), SUM(subtotal_iva15), SUM(iva5), SUM(iva15), SUM(total)
             FROM {tabla} WHERE date(fecha) BETWEEN ?1 AND ?2 GROUP BY 1"
        );
        let grupos = filas(conn, &sql, params![desde, hasta], |row| {
            Ok((row.col::<String>(0)?, (row.col::<i64>(1)?, mapear_desglose(row, 2)?)))
        })
        .await?;
        Ok(grupos.into_iter().collect())
    };
    let ventas = agrupar("ventas").await?;
    let devoluciones = agrupar("devoluciones").await?;

    Ok(claves
        .into_iter()
        .map(|periodo| {
            let (cantidad, v) = ventas.get(&periodo).copied().unwrap_or_default();
            let d = devoluciones.get(&periodo).map(|x| x.1).unwrap_or_default();
            PuntoSerie {
                ventas: cantidad,
                ventas_brutas: v.total,
                devoluciones: d.total,
                neto: v.restar(&d),
                periodo,
            }
        })
        .collect())
}

// Ventas por hora del día ("%H") o por día de la semana ("%w"). Solo las claves con ventas.
async fn distribucion(
    conn: &Connection,
    desde: &str,
    hasta: &str,
    formato: &str,
) -> libsql::Result<Vec<Distribucion>> {
    let sql = format!(
        "SELECT CAST(strftime('{formato}', fecha) AS INTEGER), COUNT(*), SUM(total)
         FROM ventas WHERE date(fecha) BETWEEN ?1 AND ?2 GROUP BY 1 ORDER BY 1"
    );
    filas(conn, &sql, params![desde, hasta], |row| {
        Ok(Distribucion {
            clave: row.col(0)?,
            ventas: row.col(1)?,
            monto: monto(row.col(2)?),
        })
    })
    .await
}

async fn productos(conn: &Connection, desde: &str, hasta: &str) -> libsql::Result<Vec<ReporteProducto>> {
    // Líneas vendidas en el rango y líneas devueltas en el rango, juntas por producto.
    // La categoría es la actual del producto (las líneas no la guardan).
    filas(
        conn,
        "WITH mov AS (
             SELECT d.producto_id, d.codigo, d.detalle, d.venta_id AS venta, d.cantidad AS uv, 0 AS ud,
                    d.subtotal AS mv, 0 AS md
             FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
             WHERE date(v.fecha) BETWEEN ?1 AND ?2
             UNION ALL
             SELECT dd.producto_id, dd.codigo, dd.detalle, NULL, 0, dd.cantidad, 0, dd.subtotal
             FROM devolucion_detalle dd JOIN devoluciones dv ON dv.id = dd.devolucion_id
             WHERE date(dv.fecha) BETWEEN ?1 AND ?2
         )
         SELECT MAX(m.codigo), MAX(m.detalle), COALESCE(p.categoria, ''), COUNT(DISTINCT m.venta),
                SUM(m.uv), SUM(m.ud), SUM(m.mv) - SUM(m.md) AS neto
         FROM mov m LEFT JOIN productos p ON p.id = m.producto_id
         GROUP BY m.producto_id
         ORDER BY neto DESC, SUM(m.uv) DESC",
        params![desde, hasta],
        |row| {
            Ok(ReporteProducto {
                codigo: row.col(0)?,
                detalle: row.col(1)?,
                categoria: row.col(2)?,
                ventas: row.col(3)?,
                unidades_vendidas: row.col(4)?,
                unidades_devueltas: row.col(5)?,
                monto_neto: monto(row.col(6)?),
            })
        },
    )
    .await
}

async fn clientes(conn: &Connection, desde: &str, hasta: &str) -> libsql::Result<Vec<ReporteCliente>> {
    // Sin cliente = consumidor final (clave 0). Las devoluciones se atribuyen al cliente de la
    // venta original. El nombre e identificación son los guardados en la venta más reciente.
    filas(
        conn,
        "WITH mov AS (
             SELECT COALESCE(cliente_id, 0) AS cli, cliente_nombre AS nombre,
                    cliente_identificacion AS ident, fecha, 1 AS compra, total AS mv, 0 AS md
             FROM ventas WHERE date(fecha) BETWEEN ?1 AND ?2
             UNION ALL
             SELECT COALESCE(v.cliente_id, 0), v.cliente_nombre, v.cliente_identificacion, NULL, 0, 0, dv.total
             FROM devoluciones dv JOIN ventas v ON v.id = dv.venta_id
             WHERE date(dv.fecha) BETWEEN ?1 AND ?2
         )
         SELECT cli,
                (SELECT m2.nombre FROM mov m2 WHERE m2.cli = mov.cli ORDER BY m2.fecha IS NULL, m2.fecha DESC LIMIT 1),
                (SELECT m2.ident FROM mov m2 WHERE m2.cli = mov.cli ORDER BY m2.fecha IS NULL, m2.fecha DESC LIMIT 1),
                SUM(compra), SUM(mv), SUM(md), MAX(fecha)
         FROM mov GROUP BY cli
         ORDER BY SUM(mv) - SUM(md) DESC",
        params![desde, hasta],
        |row| {
            let cliente: i64 = row.col(0)?;
            let total_compras = a_centavos(row.col(4)?);
            let devoluciones = a_centavos(row.col(5)?);
            let nombre: String = row.col(1)?;
            Ok(ReporteCliente {
                nombre: if cliente == 0 || nombre.is_empty() { "CONSUMIDOR FINAL".to_string() } else { nombre },
                identificacion: if cliente == 0 { String::new() } else { row.col(2)? },
                compras: row.col(3)?,
                total_compras: de_centavos(total_compras),
                devoluciones: de_centavos(devoluciones),
                neto: de_centavos(total_compras - devoluciones),
                ultima_compra: row.col(6)?,
            })
        },
    )
    .await
}

async fn devoluciones(conn: &Connection, desde: &str, hasta: &str) -> libsql::Result<Vec<ReporteDevolucion>> {
    filas(
        conn,
        "SELECT dv.id, dv.venta_id, dv.fecha, dv.motivo, dv.reembolso, COALESCE(v.cliente_nombre, ''),
                (SELECT COALESCE(SUM(dd.cantidad), 0) FROM devolucion_detalle dd WHERE dd.devolucion_id = dv.id),
                dv.total
         FROM devoluciones dv LEFT JOIN ventas v ON v.id = dv.venta_id
         WHERE date(dv.fecha) BETWEEN ?1 AND ?2
         ORDER BY dv.fecha DESC, dv.id DESC
         LIMIT ?3",
        params![desde, hasta, MAX_FILAS_DEVOLUCIONES],
        |row| {
            Ok(ReporteDevolucion {
                id: row.col(0)?,
                venta_id: row.col(1)?,
                fecha: row.col(2)?,
                motivo: row.col(3)?,
                reembolso: row.col(4)?,
                cliente_nombre: row.col(5)?,
                unidades: row.col(6)?,
                total: monto(row.col(7)?),
            })
        },
    )
    .await
}

// ---------------------------------------------------------------------------------------------
// Exportar a Excel
// ---------------------------------------------------------------------------------------------

// Una hoja del libro: el frontend arma las filas (las mismas que muestra en pantalla) y el backend
// les da formato de Excel.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HojaExcel {
    nombre: String,
    titulo: String,
    columnas: Vec<ColumnaExcel>,
    filas: Vec<Vec<serde_json::Value>>,
    // La última fila es un total: va en negrita y queda fuera del autofiltro
    #[serde(default)]
    fila_total: bool,
    // Hoja que se muestra al abrir el archivo (la pestaña que el usuario estaba viendo)
    #[serde(default)]
    activa: bool,
}

#[derive(Deserialize)]
pub struct ColumnaExcel {
    titulo: String,
    tipo: TipoColumna,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum TipoColumna {
    Texto,
    Entero,
    Dinero,
}

// Excel no admite []:*?/\ en el nombre de una hoja y lo limita a 31 caracteres.
fn nombre_hoja(nombre: &str) -> String {
    let limpio: String = nombre.chars().filter(|c| !"[]:*?/\\".contains(*c)).take(31).collect();
    if limpio.trim().is_empty() { "Hoja".to_string() } else { limpio }
}

fn armar_libro(periodo: &str, hojas: &[HojaExcel]) -> Result<Workbook, XlsxError> {
    let mut libro = Workbook::new();

    let f_titulo = Format::new().set_bold().set_font_size(14);
    let f_periodo = Format::new().set_italic().set_font_color(Color::RGB(0x595959));
    let f_encabezado = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xDCE6F5))
        .set_border_bottom(FormatBorder::Thin);
    let f_entero = Format::new().set_num_format("#,##0");
    let f_dinero = Format::new().set_num_format("$#,##0.00");
    let f_total = Format::new().set_bold().set_border_top(FormatBorder::Thin);
    let f_total_entero = f_total.clone().set_num_format("#,##0");
    let f_total_dinero = f_total.clone().set_num_format("$#,##0.00");

    // Título en la fila 1, período en la 2, encabezados en la 4 y datos desde la 5.
    const FILA_ENCABEZADO: u32 = 3;

    for hoja in hojas {
        let ws = libro.add_worksheet();
        ws.set_name(nombre_hoja(&hoja.nombre))?;

        for (c, col) in hoja.columnas.iter().enumerate() {
            ws.write_string_with_format(FILA_ENCABEZADO, c as u16, &col.titulo, &f_encabezado)?;
        }

        for (i, fila) in hoja.filas.iter().enumerate() {
            let r = FILA_ENCABEZADO + 1 + i as u32;
            let es_total = hoja.fila_total && i + 1 == hoja.filas.len();
            for (c, valor) in fila.iter().enumerate() {
                let tipo = hoja.columnas.get(c).map_or(TipoColumna::Texto, |col| col.tipo);
                let c = c as u16;
                match (valor, tipo) {
                    (serde_json::Value::Number(n), TipoColumna::Entero | TipoColumna::Dinero) => {
                        let fmt = match (tipo, es_total) {
                            (TipoColumna::Entero, false) => &f_entero,
                            (TipoColumna::Entero, true) => &f_total_entero,
                            (_, false) => &f_dinero,
                            (_, true) => &f_total_dinero,
                        };
                        ws.write_number_with_format(r, c, n.as_f64().unwrap_or(0.0), fmt)?;
                    }
                    (serde_json::Value::Null, _) => {
                        if es_total {
                            ws.write_blank(r, c, &f_total)?;
                        }
                    }
                    (v, _) => {
                        let texto = match v {
                            serde_json::Value::String(s) => s.clone(),
                            otro => otro.to_string(),
                        };
                        if es_total {
                            ws.write_string_with_format(r, c, &texto, &f_total)?;
                        } else {
                            ws.write_string(r, c, &texto)?;
                        }
                    }
                }
            }
        }

        if !hoja.columnas.is_empty() {
            let filas_datos = hoja.filas.len() as u32 - u32::from(hoja.fila_total && !hoja.filas.is_empty());
            ws.autofilter(FILA_ENCABEZADO, 0, FILA_ENCABEZADO + filas_datos, hoja.columnas.len() as u16 - 1)?;
        }
        ws.set_freeze_panes(FILA_ENCABEZADO + 1, 0)?;
        // El ancho se calcula antes de escribir el título, para que el título no ensanche la columna A.
        ws.autofit();
        ws.write_string_with_format(0, 0, &hoja.titulo, &f_titulo)?;
        ws.write_string_with_format(1, 0, periodo, &f_periodo)?;
        if hoja.activa {
            ws.set_active(true);
        }
    }
    Ok(libro)
}

// Pregunta dónde guardar (diálogo "Guardar como") y escribe el reporte como .xlsx, una hoja por
// pestaña. Devuelve la ruta elegida, o None si el usuario canceló.
// Es async para que el diálogo bloqueante no corra en el hilo principal de la ventana.
#[tauri::command]
pub async fn exportar_excel(
    app: tauri::AppHandle,
    nombre: String,
    periodo: String,
    hojas: Vec<HojaExcel>,
) -> Result<Option<String>, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_opener::OpenerExt;

    let total_filas: usize = hojas.iter().map(|h| h.filas.len()).sum();
    if hojas.is_empty() || total_filas > MAX_FILAS_EXCEL {
        return Err("El reporte es demasiado grande para exportarlo.".to_string());
    }

    let base = sanear_nombre_archivo(&nombre);
    let base = if base.is_empty() { "Reporte".to_string() } else { base };

    let mut dialogo = app
        .dialog()
        .file()
        .set_title("Guardar reporte de Excel")
        .set_file_name(format!("{base}.xlsx"))
        .add_filter("Libro de Excel", &["xlsx"]);
    if let Ok(dir) = app.path().download_dir() {
        dialogo = dialogo.set_directory(dir);
    }
    let Some(elegida) = dialogo.blocking_save_file() else {
        return Ok(None);
    };
    let mut ruta = elegida.into_path().map_err(|e| e.to_string())?;
    if !ruta.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("xlsx")) {
        ruta.set_extension("xlsx");
    }

    let mut libro = armar_libro(&periodo, &hojas).map_err(|e| format!("No se pudo generar el Excel: {e}"))?;
    libro.save(&ruta).map_err(|e| match e {
        XlsxError::IoError(io) if io.kind() == std::io::ErrorKind::PermissionDenied => {
            "No se pudo guardar: el archivo está abierto en Excel o la carpeta no permite escribir.".to_string()
        }
        otro => format!("No se pudo guardar el archivo: {otro}"),
    })?;

    let _ = app.opener().reveal_item_in_dir(&ruta);
    Ok(Some(ruta.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Devuelve también la Database: libsql la necesita viva mientras se use la conexión.
    async fn base_de_prueba() -> (libsql::Database, Connection) {
        let db = libsql::Builder::new_local(":memory:").build().await.unwrap();
        let conn = db.connect().unwrap();
        conn.execute_batch(
            "CREATE TABLE productos (id INTEGER PRIMARY KEY, categoria TEXT);
             CREATE TABLE ventas (id INTEGER PRIMARY KEY, fecha TEXT, subtotal_cero REAL, subtotal_iva5 REAL,
                 subtotal_iva15 REAL, iva5 REAL, iva15 REAL, total REAL, descuento REAL, credito REAL,
                 cliente_id INTEGER, cliente_nombre TEXT, cliente_identificacion TEXT);
             CREATE TABLE venta_detalle (id INTEGER PRIMARY KEY, venta_id INTEGER, producto_id INTEGER,
                 codigo TEXT, detalle TEXT, cantidad INTEGER, subtotal REAL);
             CREATE TABLE devoluciones (id INTEGER PRIMARY KEY, venta_id INTEGER, fecha TEXT, motivo TEXT,
                 reembolso TEXT, subtotal_cero REAL, subtotal_iva5 REAL, subtotal_iva15 REAL, iva5 REAL,
                 iva15 REAL, total REAL);
             CREATE TABLE devolucion_detalle (id INTEGER PRIMARY KEY, devolucion_id INTEGER, producto_id INTEGER,
                 codigo TEXT, detalle TEXT, cantidad INTEGER, subtotal REAL);
             INSERT INTO productos VALUES (1, 'FILTROS');
             -- Venta 1 (oct): 2 u. a $10 + IVA 15%. Venta 2 (nov): 1 u. $10.
             INSERT INTO ventas VALUES (1, '2026-10-31 18:00:00', 0, 0, 20, 0, 3, 23, 0, 0, 7, 'ANA', '0102');
             INSERT INTO ventas VALUES (2, '2026-11-02 10:00:00', 0, 0, 10, 0, 1.5, 11.5, 0, 0, NULL, '', '');
             INSERT INTO venta_detalle VALUES (1, 1, 1, 'F1', 'FILTRO', 2, 20);
             INSERT INTO venta_detalle VALUES (2, 2, 1, 'F1', 'FILTRO', 1, 10);
             -- Devolución en noviembre de 1 u. de la venta de octubre
             INSERT INTO devoluciones VALUES (1, 1, '2026-11-03 09:00:00', 'DEFECTO', 'EFECTIVO', 0, 0, 10, 0, 1.5, 11.5);
             INSERT INTO devolucion_detalle VALUES (1, 1, 1, 'F1', 'FILTRO', 1, 10);",
        )
        .await
        .unwrap();
        (db, conn)
    }

    #[tokio::test]
    async fn devoluciones_cuentan_en_su_fecha() {
        let (_db, conn) = base_de_prueba().await;
        let r = construir_reporte(&conn, "2026-11-01", "2026-11-30").await.unwrap();
        assert_eq!(r.resumen.ventas, 1);
        assert_eq!(r.resumen.ventas_brutas, 11.5);
        assert_eq!(r.resumen.monto_devuelto, 11.5);
        assert_eq!(r.resumen.ventas_netas, 0.0);
        assert_eq!(r.impuestos_neto.iva15, 0.0);
        assert_eq!(r.serie.len(), 30);
        // El producto: 1 vendida, 1 devuelta, neto $0
        assert_eq!(r.productos[0].unidades_vendidas, 1);
        assert_eq!(r.productos[0].unidades_devueltas, 1);
        assert_eq!(r.productos[0].categoria, "FILTROS");
        // La devolución se atribuye a ANA aunque su compra fue en octubre
        let ana = r.clientes.iter().find(|c| c.nombre == "ANA").unwrap();
        assert_eq!((ana.compras, ana.neto), (0, -11.5));
        // Período anterior: octubre 2 – 31
        assert_eq!((r.anterior_desde.as_str(), r.anterior_hasta.as_str()), ("2026-10-02", "2026-10-31"));
        assert_eq!(r.anterior.ventas_brutas, 23.0);
    }

    #[tokio::test]
    async fn rangos_largos_se_agrupan_por_mes() {
        let (_db, conn) = base_de_prueba().await;
        let r = construir_reporte(&conn, "2026-01-01", "2026-12-31").await.unwrap();
        assert_eq!(r.agrupacion, "mes");
        assert_eq!(r.serie.len(), 12);
        let nov = r.serie.iter().find(|p| p.periodo == "2026-11").unwrap();
        assert_eq!((nov.ventas, nov.ventas_brutas, nov.devoluciones), (1, 11.5, 11.5));
    }

    #[tokio::test]
    async fn rechaza_fechas_invalidas() {
        let (_db, conn) = base_de_prueba().await;
        assert!(validar_rango(&conn, "2026-11-30", "2026-11-01").await.is_err());
        assert!(validar_rango(&conn, "2026-13-01", "2026-12-01").await.is_err());
        assert!(validar_rango(&conn, "hoy", "2026-12-01").await.is_err());
        assert!(validar_rango(&conn, "2026-11-01", "2026-11-01").await.is_ok());
    }

    // Sin ventas, las sumas vienen como el entero 0: antes de db::col esto hacía caer la app con libsql.
    #[tokio::test]
    async fn reporte_de_un_periodo_vacio() {
        let (_db, conn) = base_de_prueba().await;
        let r = construir_reporte(&conn, "2020-01-01", "2020-01-31").await.unwrap();
        assert_eq!((r.resumen.ventas, r.resumen.ventas_brutas, r.impuestos_neto.total), (0, 0.0, 0.0));
    }
}

#[cfg(test)]
mod tests_excel {
    use super::*;

    #[test]
    fn arma_libro_con_varias_hojas_y_fila_total() {
        let hojas: Vec<HojaExcel> = serde_json::from_value(serde_json::json!([
            {
                "nombre": "Resumen", "titulo": "Resumen de ventas", "filaTotal": true,
                "columnas": [{"titulo": "Período", "tipo": "texto"}, {"titulo": "Ventas", "tipo": "entero"},
                             {"titulo": "Neto", "tipo": "dinero"}],
                "filas": [["01/11", 3, 12.5], ["02/11", 0, 0], ["TOTAL", 3, 12.5]]
            },
            {
                "nombre": "Clientes: [todos]?", "titulo": "Clientes", "activa": true,
                "columnas": [{"titulo": "Cliente", "tipo": "texto"}, {"titulo": "Última compra", "tipo": "texto"}],
                "filas": [["ÑANDÚ S.A.", null]]
            },
            { "nombre": "Vacía", "titulo": "Sin datos", "columnas": [{"titulo": "A", "tipo": "texto"}], "filas": [] }
        ]))
        .unwrap();

        let mut libro = armar_libro("Del 01/11/2026 al 02/11/2026", &hojas).unwrap();
        let bytes = libro.save_to_buffer().unwrap();
        assert!(bytes.starts_with(b"PK"), "un .xlsx es un zip");
        assert_eq!(nombre_hoja("Clientes: [todos]?"), "Clientes todos");
    }
}
