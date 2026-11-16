import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DatosNegocio } from "@/components/datos-negocio";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Boxes,
  CalendarDays,
  Hash,
  PackageX,
  RefreshCw,
  ShoppingCart,
  Trophy,
  Wallet,
} from "lucide-react";
import type { Vista } from "@/components/app-sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  aFecha,
  aISO,
  DIAS_SEMANA,
  dinero,
  entero,
  GraficoColumnas,
  Indicador,
  Linea,
  m2,
  MESES,
  MESES_LARGOS,
  plural,
  Vacio,
  Variacion,
} from "@/components/reporte-ui";

// ---------------------------------------------------------------------------------------------
// Datos: el resumen del panel (inventario, alertas, listas) + el reporte de hoy y del mes, que son
// los mismos números que muestra la sección Reportes.
// ---------------------------------------------------------------------------------------------

// Debe coincidir con ResumenPanel en src-tauri/src/lib.rs (solo los campos que se usan aquí)
interface ResumenPanel {
  totalProductos: number;
  productosSinStock: number;
  productosStockBajo: number;
  unidadesEnStock: number;
  valorInventario: number;
  ventasPorDia: { fecha: string; total: number; cantidad: number }[];
  masVendidos: { codigo: string; detalle: string; unidades: number; monto: number }[];
  alertasStock: { id: number; codigo: string; detalle: string; stock: number }[];
  ultimasVentas: { id: number; fecha: string; total: number; unidades: number; clienteNombre: string }[];
}

// Debe coincidir con ResumenReporte en src-tauri/src/reportes.rs
interface ResumenPeriodo {
  ventas: number;
  ventasBrutas: number;
  unidades: number;
  montoDevuelto: number;
  ventasNetas: number;
  ticketPromedio: number;
  cobrado: number;
  creditoAplicado: number;
  reembolsadoEfectivo: number;
}

interface ReportePeriodo {
  resumen: ResumenPeriodo;
  anterior: ResumenPeriodo;
}

interface DatosPanel {
  panel: ResumenPanel;
  hoy: ReportePeriodo; // su "anterior" es ayer
  mes: ResumenPeriodo; // del 1 a hoy
  mesPrevio: ResumenPeriodo; // mismo tramo del mes anterior (del 1 al mismo día)
}

async function cargarDatos(): Promise<DatosPanel> {
  const ahora = new Date();
  const hoy = aISO(ahora);
  const inicioMes = aISO(new Date(ahora.getFullYear(), ahora.getMonth(), 1));
  const inicioMesPrevio = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
  // El mismo día del mes anterior, o su último día si es más corto (31 → 30)
  const ultimoDiaPrevio = new Date(ahora.getFullYear(), ahora.getMonth(), 0).getDate();
  const finMesPrevio = new Date(
    inicioMesPrevio.getFullYear(),
    inicioMesPrevio.getMonth(),
    Math.min(ahora.getDate(), ultimoDiaPrevio)
  );

  const [panel, reporteHoy, reporteMes, reporteMesPrevio] = await Promise.all([
    invoke<ResumenPanel>("obtener_resumen_panel"),
    invoke<ReportePeriodo>("obtener_reporte", { desde: hoy, hasta: hoy }),
    invoke<ReportePeriodo>("obtener_reporte", { desde: inicioMes, hasta: hoy }),
    invoke<ReportePeriodo>("obtener_reporte", { desde: aISO(inicioMesPrevio), hasta: aISO(finMesPrevio) }),
  ]);
  return { panel, hoy: reporteHoy, mes: reporteMes.resumen, mesPrevio: reporteMesPrevio.resumen };
}

// Filas visibles en las listas de abajo (mantiene las tres tarjetas a la misma altura)
const FILAS_LISTA = 5;

function fechaLarga(texto: string) {
  const f = aFecha(texto);
  return `${DIAS_SEMANA[f.getDay()]} ${f.getDate()} ${MESES[f.getMonth()]}`;
}

// "2026-11-06 14:32:10" -> "hoy 14:32" / "6 nov 14:32"
function fechaCorta(texto: string) {
  const f = aFecha(texto);
  const hora = texto.slice(11, 16);
  const esHoy = f.toDateString() === new Date().toDateString();
  return `${esHoy ? "hoy" : `${f.getDate()} ${MESES[f.getMonth()]}`} ${hora}`;
}

function saludo() {
  const h = new Date().getHours();
  return h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
}

// ---------------------------------------------------------------------------------------------
// Vista
// ---------------------------------------------------------------------------------------------

export function DashboardView({ onNavegar }: { onNavegar?: (vista: Vista) => void }) {
  const [datos, setDatos] = useState<DatosPanel | null>(null);
  const [error, setError] = useState("");
  const [actualizando, setActualizando] = useState(false);
  // Nombre comercial guardado en Configuración → Datos del negocio ("" si aún no se ha puesto)
  const [nombreNegocio, setNombreNegocio] = useState("");

  useEffect(() => {
    invoke<DatosNegocio>("obtener_datos_negocio")
      .then((d) => setNombreNegocio(d.nombreComercial.trim()))
      .catch((err) => console.error("Error al cargar los datos del negocio:", err));
  }, []);

  const cargar = async () => {
    setActualizando(true);
    try {
      setDatos(await cargarDatos());
      setError("");
    } catch (err) {
      console.error("Error al cargar el panel:", err);
      setError(typeof err === "string" ? err : "No se pudo cargar el resumen.");
    } finally {
      setActualizando(false);
    }
  };

  useEffect(() => {
    cargar();
  }, []);

  const ahora = new Date();
  const tituloFecha = `${DIAS_SEMANA[ahora.getDay()]} ${ahora.getDate()} de ${MESES_LARGOS[ahora.getMonth()]} de ${ahora.getFullYear()}`;
  const mesPrevio = MESES_LARGOS[new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1).getMonth()];

  return (
    <div className="space-y-4">
      {/* Encabezado */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight uppercase">{nombreNegocio || "Panel principal"}</h1>
          <p className="text-xs text-muted-foreground">
            {saludo()} · <span className="capitalize">{tituloFecha}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={cargar}
            disabled={actualizando}
            aria-label="Actualizar"
            title="Actualizar"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${actualizando ? "animate-spin" : ""}`} />
          </Button>
          {onNavegar && (
            <>
              <Button type="button" variant="outline" onClick={() => onNavegar("reportes")}>
                <BarChart3 className="h-3.5 w-3.5" />
                Ver reportes
              </Button>
              <Button type="button" onClick={() => onNavegar("venta")}>
                <ShoppingCart className="h-3.5 w-3.5" />
                Nueva venta
              </Button>
            </>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!datos ? (
        <PanelSkeleton />
      ) : (
        <Contenido datos={datos} mesPrevio={mesPrevio} onNavegar={onNavegar} />
      )}
    </div>
  );
}

function Contenido({
  datos,
  mesPrevio,
  onNavegar,
}: {
  datos: DatosPanel;
  mesPrevio: string;
  onNavegar?: (vista: Vista) => void;
}) {
  const { panel, mes } = datos;
  const hoy = datos.hoy.resumen;
  const ayer = datos.hoy.anterior;
  const porReponer = panel.productosSinStock + panel.productosStockBajo;
  const ultimo = panel.ventasPorDia.length - 1;

  return (
    <>
      {/* 1. Indicadores clave */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Indicador
          titulo="Ventas de hoy"
          icono={Wallet}
          valor={dinero(hoy.ventasNetas)}
          junto={plural(hoy.ventas, "venta")}
          pie={<Variacion actual={hoy.ventasNetas} anterior={ayer.ventasNetas} contra="vs. ayer" sinDatos="Ayer: sin ventas" />}
        />
        <Indicador
          titulo="Ventas del mes"
          icono={CalendarDays}
          valor={dinero(mes.ventasNetas)}
          junto={plural(mes.ventas, "venta")}
          pie={
            <Variacion
              actual={mes.ventasNetas}
              anterior={datos.mesPrevio.ventasNetas}
              contra={`vs. mismo tramo de ${mesPrevio}`}
              sinDatos={`Sin ventas en ${mesPrevio}`}
            />
          }
        />
        <Indicador
          titulo="Ticket promedio del mes"
          icono={Hash}
          valor={dinero(mes.ticketPromedio)}
          pie={
            <Variacion
              actual={mes.ticketPromedio}
              anterior={datos.mesPrevio.ticketPromedio}
              contra={`vs. ${mesPrevio}`}
              sinDatos={`Sin ventas en ${mesPrevio}`}
            />
          }
        />
        <Indicador
          titulo="Inventario (a precio de venta)"
          icono={Boxes}
          valor={dinero(panel.valorInventario)}
          junto={plural(panel.totalProductos, "producto")}
          pie={
            porReponer === 0 ? (
              "Todo con stock suficiente"
            ) : (
              <span className="flex flex-wrap gap-1">
                {panel.productosSinStock > 0 && <EstadoStock tipo="sin" texto={`${panel.productosSinStock} sin stock`} />}
                {panel.productosStockBajo > 0 && <EstadoStock tipo="bajo" texto={`${panel.productosStockBajo} stock bajo`} />}
              </span>
            )
          }
        />
      </div>

      {/* 2. Tendencia + caja del día */}
      <div className="grid gap-3 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <GraficoColumnas
            titulo={`Ventas de los últimos ${panel.ventasPorDia.length} días`}
            descripcion={`${dinero(m2(panel.ventasPorDia.reduce((a, d) => a + d.total, 0)))} netas · ${plural(
              panel.ventasPorDia.reduce((a, d) => a + d.cantidad, 0),
              "venta"
            )}`}
            alto="h-40"
            puntos={panel.ventasPorDia.map((d, i) => {
              const f = aFecha(d.fecha);
              return {
                clave: d.fecha,
                valor: d.total,
                etiquetaEje: i === ultimo ? "Hoy" : i === 0 || f.getDate() === 1 ? `${f.getDate()} ${MESES[f.getMonth()]}` : String(f.getDate()),
                etiquetaLarga: fechaLarga(d.fecha),
                detalle: plural(d.cantidad, "venta"),
                destacado: i === ultimo,
              };
            })}
          />
        </div>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Caja de hoy</CardTitle>
            <CardDescription>
              {plural(hoy.ventas, "venta")} · {plural(hoy.unidades, "unidad", "unidades")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="space-y-1">
              <Linea etiqueta="Ventas brutas" valor={dinero(hoy.ventasBrutas)} />
              <Linea etiqueta="(−) Devoluciones" valor={dinero(-hoy.montoDevuelto)} tenue />
              <Linea etiqueta="Ventas netas" valor={dinero(hoy.ventasNetas)} total />
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Efectivo</p>
              <Linea etiqueta="Cobrado a clientes" valor={dinero(hoy.cobrado)} />
              {hoy.creditoAplicado > 0 && (
                <Linea etiqueta="Pagado con crédito de cambios" valor={dinero(hoy.creditoAplicado)} tenue />
              )}
              <Linea etiqueta="(−) Reembolsos en efectivo" valor={dinero(-hoy.reembolsadoEfectivo)} tenue />
              <Linea etiqueta="Efectivo neto en caja" valor={dinero(m2(hoy.cobrado - hoy.reembolsadoEfectivo))} total />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 3. Listas de seguimiento */}
      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        <TarjetaLista
          titulo="Más vendidos del mes"
          icono={Trophy}
          accion={onNavegar && { texto: "Reportes", alPulsar: () => onNavegar("reportes") }}
        >
          {panel.masVendidos.length === 0 ? (
            <Vacio texto="Todavía no hay ventas este mes." />
          ) : (
            <MasVendidos productos={panel.masVendidos} />
          )}
        </TarjetaLista>

        <TarjetaLista
          titulo="Productos por reponer"
          icono={PackageX}
          accion={onNavegar && { texto: "Inventario", alPulsar: () => onNavegar("inventario") }}
        >
          {panel.alertasStock.length === 0 ? (
            <Vacio texto="Todo tiene stock suficiente." />
          ) : (
            <ul className="divide-y">
              {panel.alertasStock.slice(0, FILAS_LISTA).map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-1.5 first:pt-0 last:pb-0">
                  <span className="min-w-0 truncate text-sm uppercase">
                    {p.detalle}
                    <span className="ml-2 font-mono text-[11px] text-muted-foreground">{p.codigo}</span>
                  </span>
                  {p.stock <= 0 ? (
                    <EstadoStock tipo="sin" texto="Sin stock" />
                  ) : (
                    <EstadoStock tipo="bajo" texto={`${p.stock} u.`} />
                  )}
                </li>
              ))}
              {porReponer > FILAS_LISTA && (
                <li className="pt-1.5 text-xs text-muted-foreground">y {porReponer - FILAS_LISTA} más…</li>
              )}
            </ul>
          )}
        </TarjetaLista>

        <TarjetaLista
          titulo="Últimas ventas"
          icono={ShoppingCart}
          accion={onNavegar && { texto: "Venta", alPulsar: () => onNavegar("venta") }}
        >
          {panel.ultimasVentas.length === 0 ? (
            <Vacio texto="Todavía no hay ventas registradas." />
          ) : (
            <ul className="divide-y">
              {panel.ultimasVentas.slice(0, FILAS_LISTA).map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-3 py-1.5 text-sm first:pt-0 last:pb-0">
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-xs font-semibold">N.º {v.id}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {fechaCorta(v.fecha)} · {v.clienteNombre || "Consumidor final"}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{dinero(v.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </TarjetaLista>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Piezas del panel
// ---------------------------------------------------------------------------------------------

function TarjetaLista({
  titulo,
  icono: Icono,
  accion,
  children,
}: {
  titulo: string;
  icono: typeof Wallet;
  accion?: { texto: string; alPulsar: () => void } | false;
  children: React.ReactNode;
}) {
  return (
    <Card size="sm">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Icono className="h-3.5 w-3.5 text-primary/70" aria-hidden="true" />
          {titulo}
        </CardTitle>
        {accion && (
          <Button type="button" variant="ghost" size="xs" onClick={accion.alPulsar} className="-my-1">
            {accion.texto}
            <ArrowRight className="h-3 w-3" />
          </Button>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// Estado de stock con ícono + texto, mismos colores que en Inventario.
function EstadoStock({ tipo, texto }: { tipo: "sin" | "bajo"; texto: string }) {
  if (tipo === "sin") {
    return (
      <Badge variant="destructive" className="shrink-0 gap-1 text-[11px]">
        <PackageX className="h-3 w-3" aria-hidden="true" />
        {texto}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="shrink-0 gap-1 border-amber-500 text-[11px] text-amber-600 dark:text-amber-400">
      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      {texto}
    </Badge>
  );
}

// Lista de más vendidos con una barra horizontal fina proporcional a las unidades.
function MasVendidos({ productos }: { productos: ResumenPanel["masVendidos"] }) {
  const max = Math.max(...productos.map((p) => p.unidades), 1);
  return (
    <ol className="space-y-2">
      {productos.slice(0, FILAS_LISTA).map((p, i) => (
        <li key={`${p.codigo}-${i}`} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate uppercase">
              <span className="mr-1.5 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
              {p.detalle}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              <span className="font-semibold text-foreground">{entero(p.unidades)} u.</span> · {dinero(p.monto)}
            </span>
          </div>
          <div className="h-1 w-full rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-serie-1"
              style={{ width: `${Math.max((p.unidades / max) * 100, 2)}%` }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Cargando">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} size="sm">
            <CardContent className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-6 w-28" />
              <Skeleton className="h-3 w-36" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <Card size="sm" className="xl:col-span-2">
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-40 w-full" />
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-32" />
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-3 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
