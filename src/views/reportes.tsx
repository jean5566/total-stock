import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDown,
  ArrowUp,
  CalendarRange,
  Clock,
  Download,
  Hash,
  Package,
  Receipt,
  RefreshCw,
  Search,
  Undo2,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  aFecha,
  aISO,
  DIAS_SEMANA,
  DIAS_SEMANA_LARGOS,
  dinero,
  entero,
  fechaTexto,
  GraficoColumnas,
  Indicador,
  Linea,
  m2,
  MESES,
  MESES_LARGOS,
  plural,
  porcentaje,
  Vacio,
  Variacion,
} from "@/components/reporte-ui";

// ---------------------------------------------------------------------------------------------
// Tipos (deben coincidir con Reporte en src-tauri/src/reportes.rs)
// ---------------------------------------------------------------------------------------------

interface Resumen {
  ventas: number;
  ventasBrutas: number;
  descuentos: number;
  unidades: number;
  devoluciones: number;
  montoDevuelto: number;
  unidadesDevueltas: number;
  ventasNetas: number;
  ticketPromedio: number;
  clientes: number;
  cobrado: number;
  creditoAplicado: number;
  reembolsadoEfectivo: number;
}

interface Desglose {
  subtotalCero: number;
  subtotalIva5: number;
  subtotalIva15: number;
  iva5: number;
  iva15: number;
  total: number;
}

interface PuntoSerie {
  periodo: string; // AAAA-MM-DD o AAAA-MM
  ventas: number;
  ventasBrutas: number;
  devoluciones: number;
  neto: Desglose;
}

interface Distribucion {
  clave: number;
  ventas: number;
  monto: number;
}

interface ReporteProducto {
  codigo: string;
  detalle: string;
  categoria: string;
  ventas: number;
  unidadesVendidas: number;
  unidadesDevueltas: number;
  montoNeto: number;
}

interface ReporteCliente {
  nombre: string;
  identificacion: string;
  compras: number;
  totalCompras: number;
  devoluciones: number;
  neto: number;
  ultimaCompra: string | null;
}

interface ReporteDevolucion {
  id: number;
  ventaId: number;
  fecha: string;
  motivo: string;
  reembolso: "EFECTIVO" | "CAMBIO";
  clienteNombre: string;
  unidades: number;
  total: number;
}

interface Reporte {
  desde: string;
  hasta: string;
  anteriorDesde: string;
  anteriorHasta: string;
  agrupacion: "dia" | "mes";
  resumen: Resumen;
  anterior: Resumen;
  serie: PuntoSerie[];
  porHora: Distribucion[];
  porDiaSemana: Distribucion[];
  productos: ReporteProducto[];
  clientes: ReporteCliente[];
  impuestosVentas: Desglose;
  impuestosDevoluciones: Desglose;
  impuestosNeto: Desglose;
  devoluciones: ReporteDevolucion[];
}

// ---------------------------------------------------------------------------------------------
// Formato y fechas
// ---------------------------------------------------------------------------------------------

// "2026-11-06 14:32:10" -> "6 nov 2026 · 14:32"
const fechaHora = (texto: string) => `${fechaTexto(texto)} · ${texto.slice(11, 16)}`;

function etiquetaPeriodo(periodo: string, agrupacion: "dia" | "mes") {
  if (agrupacion === "mes") {
    const [a, m] = periodo.split("-").map(Number);
    return `${MESES_LARGOS[m - 1]} ${a}`;
  }
  const f = aFecha(periodo);
  return `${DIAS_SEMANA[f.getDay()]} ${f.getDate()} ${MESES[f.getMonth()]} ${f.getFullYear()}`;
}

type Preset =
  | "hoy"
  | "ayer"
  | "ultimos7"
  | "ultimos30"
  | "esteMes"
  | "mesAnterior"
  | "esteAnio"
  | "anioAnterior"
  | "personalizado";

const PRESETS: { valor: Preset; etiqueta: string }[] = [
  { valor: "hoy", etiqueta: "Hoy" },
  { valor: "ayer", etiqueta: "Ayer" },
  { valor: "ultimos7", etiqueta: "Últimos 7 días" },
  { valor: "ultimos30", etiqueta: "Últimos 30 días" },
  { valor: "esteMes", etiqueta: "Este mes" },
  { valor: "mesAnterior", etiqueta: "Mes anterior" },
  { valor: "esteAnio", etiqueta: "Este año" },
  { valor: "anioAnterior", etiqueta: "Año anterior" },
  { valor: "personalizado", etiqueta: "Personalizado" },
];

function rangoDePreset(preset: Exclude<Preset, "personalizado">): [string, string] {
  const hoy = new Date();
  const a = hoy.getFullYear();
  const m = hoy.getMonth();
  const d = hoy.getDate();
  switch (preset) {
    case "hoy":
      return [aISO(hoy), aISO(hoy)];
    case "ayer": {
      const ayer = new Date(a, m, d - 1);
      return [aISO(ayer), aISO(ayer)];
    }
    case "ultimos7":
      return [aISO(new Date(a, m, d - 6)), aISO(hoy)];
    case "ultimos30":
      return [aISO(new Date(a, m, d - 29)), aISO(hoy)];
    case "esteMes":
      return [aISO(new Date(a, m, 1)), aISO(hoy)];
    case "mesAnterior":
      return [aISO(new Date(a, m - 1, 1)), aISO(new Date(a, m, 0))];
    case "esteAnio":
      return [aISO(new Date(a, 0, 1)), aISO(hoy)];
    case "anioAnterior":
      return [aISO(new Date(a - 1, 0, 1)), aISO(new Date(a - 1, 11, 31))];
  }
}

// ---------------------------------------------------------------------------------------------
// Excel: una hoja por pestaña. Debe coincidir con HojaExcel en src-tauri/src/reportes.rs
// ---------------------------------------------------------------------------------------------

type Celda = string | number | null;
type TipoColumna = "texto" | "entero" | "dinero";

interface HojaExcel {
  nombre: string;
  titulo: string;
  columnas: { titulo: string; tipo: TipoColumna }[];
  filas: Celda[][];
  filaTotal?: boolean;
  activa?: boolean;
}

// Columnas a partir de pares [título, tipo], para que cada hoja se lea como una tabla.
const cols = (...c: [string, TipoColumna][]) => c.map(([titulo, tipo]) => ({ titulo, tipo }));

type Pestana = "resumen" | "productos" | "categorias" | "clientes" | "impuestos" | "devoluciones";

const PESTANAS: { valor: Pestana; etiqueta: string }[] = [
  { valor: "resumen", etiqueta: "Resumen" },
  { valor: "productos", etiqueta: "Productos" },
  { valor: "categorias", etiqueta: "Categorías" },
  { valor: "clientes", etiqueta: "Clientes" },
  { valor: "impuestos", etiqueta: "Impuestos" },
  { valor: "devoluciones", etiqueta: "Devoluciones" },
];

interface ReporteCategoria {
  categoria: string;
  productos: number;
  unidades: number;
  montoNeto: number;
}

function agruparCategorias(productos: ReporteProducto[]): ReporteCategoria[] {
  const mapa = new Map<string, ReporteCategoria>();
  for (const p of productos) {
    const clave = p.categoria || "SIN CATEGORÍA";
    const c = mapa.get(clave) ?? { categoria: clave, productos: 0, unidades: 0, montoNeto: 0 };
    c.productos += 1;
    c.unidades += p.unidadesVendidas - p.unidadesDevueltas;
    c.montoNeto = m2(c.montoNeto + p.montoNeto);
    mapa.set(clave, c);
  }
  return [...mapa.values()].sort((a, b) => b.montoNeto - a.montoNeto);
}

// Todas las pestañas del reporte como hojas de un mismo libro; la pestaña abierta queda activa.
function hojasExcel(r: Reporte, categorias: ReporteCategoria[], pestanaActiva: Pestana): HojaExcel[] {
  const s = r.resumen;
  const periodo = (p: string) => etiquetaPeriodo(p, r.agrupacion);
  const hojas: Record<Pestana, Omit<HojaExcel, "nombre" | "activa">> = {
    resumen: {
      titulo: "Resumen de ventas",
      columnas: cols(["Período", "texto"], ["Ventas", "entero"], ["Ventas brutas", "dinero"],
        ["Devoluciones", "dinero"], ["Ventas netas", "dinero"]),
      filas: [
        ...r.serie.map((p) => [periodo(p.periodo), p.ventas, p.ventasBrutas, p.devoluciones, p.neto.total]),
        ["TOTAL", s.ventas, s.ventasBrutas, s.montoDevuelto, s.ventasNetas],
      ],
      filaTotal: true,
    },
    productos: {
      titulo: "Ventas por producto",
      columnas: cols(["Código", "texto"], ["Producto", "texto"], ["Categoría", "texto"], ["Ventas", "entero"],
        ["Unidades vendidas", "entero"], ["Unidades devueltas", "entero"], ["Unidades netas", "entero"],
        ["Venta neta sin IVA", "dinero"]),
      filas: r.productos.map((p) => [
        p.codigo, p.detalle, p.categoria, p.ventas, p.unidadesVendidas, p.unidadesDevueltas,
        p.unidadesVendidas - p.unidadesDevueltas, p.montoNeto,
      ]),
    },
    categorias: {
      titulo: "Ventas por categoría",
      columnas: cols(["Categoría", "texto"], ["Productos", "entero"], ["Unidades netas", "entero"],
        ["Venta neta sin IVA", "dinero"]),
      filas: categorias.map((c) => [c.categoria, c.productos, c.unidades, c.montoNeto]),
    },
    clientes: {
      titulo: "Ventas por cliente",
      columnas: cols(["Cliente", "texto"], ["Identificación", "texto"], ["Compras", "entero"],
        ["Total compras", "dinero"], ["Devoluciones", "dinero"], ["Neto", "dinero"], ["Última compra", "texto"]),
      filas: r.clientes.map((c) => [
        c.nombre, c.identificacion, c.compras, c.totalCompras, c.devoluciones, c.neto, c.ultimaCompra ?? null,
      ]),
    },
    impuestos: {
      titulo: "Impuestos (IVA)",
      columnas: cols(["Período", "texto"], ["Base 0%", "dinero"], ["Base 5%", "dinero"], ["Base 15%", "dinero"],
        ["IVA 5%", "dinero"], ["IVA 15%", "dinero"], ["Total", "dinero"]),
      filas: [
        ...r.serie.map((p) => [
          periodo(p.periodo), p.neto.subtotalCero, p.neto.subtotalIva5, p.neto.subtotalIva15,
          p.neto.iva5, p.neto.iva15, p.neto.total,
        ]),
        [
          "TOTAL", r.impuestosNeto.subtotalCero, r.impuestosNeto.subtotalIva5, r.impuestosNeto.subtotalIva15,
          r.impuestosNeto.iva5, r.impuestosNeto.iva15, r.impuestosNeto.total,
        ],
      ],
      filaTotal: true,
    },
    devoluciones: {
      titulo: "Devoluciones",
      columnas: cols(["N.º", "entero"], ["Fecha", "texto"], ["Venta N.º", "entero"], ["Cliente", "texto"],
        ["Motivo", "texto"], ["Reembolso", "texto"], ["Unidades", "entero"], ["Total", "dinero"]),
      filas: r.devoluciones.map((d) => [
        d.id, d.fecha, d.ventaId, d.clienteNombre || "CONSUMIDOR FINAL", d.motivo,
        d.reembolso === "EFECTIVO" ? "Efectivo" : "Cambio de producto", d.unidades, d.total,
      ]),
    },
  };
  return PESTANAS.map((p) => ({ nombre: p.etiqueta, activa: p.valor === pestanaActiva, ...hojas[p.valor] }));
}

// ---------------------------------------------------------------------------------------------
// Vista
// ---------------------------------------------------------------------------------------------

export function ReportesView() {
  const [preset, setPreset] = useState<Preset>("esteMes");
  const [[desde, hasta], setRango] = useState<[string, string]>(() => rangoDePreset("esteMes"));
  const [pestana, setPestana] = useState<Pestana>("resumen");
  const [reporte, setReporte] = useState<Reporte | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [recarga, setRecarga] = useState(0);

  const rangoValido = desde !== "" && hasta !== "" && desde <= hasta;

  useEffect(() => {
    if (!rangoValido) return;
    let vigente = true;
    setCargando(true);
    invoke<Reporte>("obtener_reporte", { desde, hasta })
      .then((r) => {
        if (!vigente) return;
        setReporte(r);
        setError("");
      })
      .catch((err) => {
        if (!vigente) return;
        console.error("Error al cargar el reporte:", err);
        setError(typeof err === "string" ? err : "No se pudo generar el reporte.");
      })
      .finally(() => vigente && setCargando(false));
    return () => {
      vigente = false;
    };
  }, [desde, hasta, rangoValido, recarga]);

  const categorias = useMemo(() => (reporte ? agruparCategorias(reporte.productos) : []), [reporte]);

  const elegirPreset = (valor: Preset) => {
    setPreset(valor);
    if (valor !== "personalizado") setRango(rangoDePreset(valor));
  };

  const cambiarFecha = (campo: "desde" | "hasta", valor: string) => {
    setPreset("personalizado");
    setRango(([d, h]) => (campo === "desde" ? [valor, h] : [d, valor]));
  };

  const [exportando, setExportando] = useState(false);

  // Abre el diálogo "Guardar como" (el usuario elige carpeta y nombre) y guarda el .xlsx.
  const exportar = async () => {
    if (!reporte) return;
    setExportando(true);
    try {
      const ruta = await invoke<string | null>("exportar_excel", {
        nombre: `Reporte ${reporte.desde} a ${reporte.hasta}`,
        periodo: `Del ${fechaTexto(reporte.desde)} al ${fechaTexto(reporte.hasta)}`,
        hojas: hojasExcel(reporte, categorias, pestana),
      });
      if (ruta) {
        setAviso(`Guardado en ${ruta}`);
        setError("");
      }
    } catch (err) {
      setError(typeof err === "string" ? err : "No se pudo exportar el reporte.");
    } finally {
      setExportando(false);
    }
  };

  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(""), 6000);
    return () => clearTimeout(t);
  }, [aviso]);

  return (
    <div className="space-y-4">
      {/* Encabezado */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Reportes</h1>
          <p className="text-xs text-muted-foreground">
            {reporte ? (
              <>
                {fechaTexto(reporte.desde)} – {fechaTexto(reporte.hasta)}
                <span className="mx-1.5">·</span>
                comparado con {fechaTexto(reporte.anteriorDesde)} – {fechaTexto(reporte.anteriorHasta)}
              </>
            ) : (
              "Análisis de ventas, productos, clientes e impuestos por período."
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={preset} onValueChange={(v) => v && elegirPreset(v as Preset)}>
            <SelectTrigger className="flex-1 sm:w-[160px] sm:flex-none" aria-label="Período">
              <CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />
              <SelectValue>{(v: string) => PRESETS.find((p) => p.valor === v)?.etiqueta ?? "Período"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p.valor} value={p.valor}>
                  {p.etiqueta}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex w-full items-center gap-1.5 sm:w-auto">
            <Input
              type="date"
              value={desde}
              max={hasta || undefined}
              onChange={(e) => cambiarFecha("desde", e.target.value)}
              className="min-w-0 flex-1 sm:w-[140px] sm:flex-none"
              aria-label="Desde"
            />
            <span className="text-xs text-muted-foreground">a</span>
            <Input
              type="date"
              value={hasta}
              min={desde || undefined}
              onChange={(e) => cambiarFecha("hasta", e.target.value)}
              className="min-w-0 flex-1 sm:w-[140px] sm:flex-none"
              aria-label="Hasta"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setRecarga((n) => n + 1)}
            disabled={cargando || !rangoValido}
            aria-label="Actualizar"
            title="Actualizar"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${cargando ? "animate-spin" : ""}`} />
          </Button>
          <Button type="button" onClick={exportar} disabled={!reporte || cargando || exportando}>
            <Download className="h-3.5 w-3.5" />
            {exportando ? "Exportando…" : "Exportar a Excel"}
          </Button>
        </div>
      </div>

      {!rangoValido && (
        <p className="text-sm text-destructive">Elige un rango válido: la fecha inicial no puede ser posterior a la final.</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {aviso && <p className="text-xs text-emerald-600 dark:text-emerald-400">{aviso}</p>}

      <Tabs value={pestana} onValueChange={(v) => setPestana(v as Pestana)}>
        <TabsList variant="line" className="w-full justify-start overflow-x-auto border-b pb-1">
          {PESTANAS.map((p) => (
            <TabsTrigger key={p.valor} value={p.valor} className="flex-none px-3">
              {p.etiqueta}
            </TabsTrigger>
          ))}
        </TabsList>

        {!reporte ? (
          <ReporteSkeleton />
        ) : (
          <div className={`pt-2 transition-opacity ${cargando ? "opacity-60" : ""}`}>
            <TabsContent value="resumen">
              <PestanaResumen r={reporte} />
            </TabsContent>
            <TabsContent value="productos">
              <PestanaProductos r={reporte} />
            </TabsContent>
            <TabsContent value="categorias">
              <PestanaCategorias categorias={categorias} />
            </TabsContent>
            <TabsContent value="clientes">
              <PestanaClientes r={reporte} />
            </TabsContent>
            <TabsContent value="impuestos">
              <PestanaImpuestos r={reporte} />
            </TabsContent>
            <TabsContent value="devoluciones">
              <PestanaDevoluciones r={reporte} />
            </TabsContent>
          </div>
        )}
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------------------------

function PestanaResumen({ r }: { r: Reporte }) {
  const s = r.resumen;
  const a = r.anterior;
  const efectivoNeto = m2(s.cobrado - s.reembolsadoEfectivo);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Indicador
          titulo="Ventas netas"
          icono={Wallet}
          valor={dinero(s.ventasNetas)}
          pie={<Variacion actual={s.ventasNetas} anterior={a.ventasNetas} />}
        />
        <Indicador
          titulo="Transacciones"
          icono={Receipt}
          valor={entero(s.ventas)}
          junto={s.clientes > 0 ? `${entero(s.clientes)} cliente${s.clientes === 1 ? "" : "s"} identificados` : undefined}
          pie={<Variacion actual={s.ventas} anterior={a.ventas} />}
        />
        <Indicador
          titulo="Ticket promedio"
          icono={Hash}
          valor={dinero(s.ticketPromedio)}
          pie={<Variacion actual={s.ticketPromedio} anterior={a.ticketPromedio} />}
        />
        <Indicador
          titulo="Unidades vendidas"
          icono={Package}
          valor={entero(s.unidades)}
          junto={s.unidadesDevueltas > 0 ? `${entero(s.unidadesDevueltas)} devueltas` : undefined}
          pie={<Variacion actual={s.unidades} anterior={a.unidades} />}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <GraficoSerie serie={r.serie} agrupacion={r.agrupacion} />
        </div>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Estado del período</CardTitle>
            <CardDescription>Cómo se llega a las ventas netas y al efectivo</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="space-y-1">
              <Linea etiqueta="Ventas brutas" valor={dinero(s.ventasBrutas)} />
              <Linea etiqueta="(−) Devoluciones" valor={dinero(-s.montoDevuelto)} tenue />
              <Linea etiqueta="Ventas netas" valor={dinero(s.ventasNetas)} total />
              {s.descuentos > 0 && (
                <p className="pt-1 text-[11px] text-muted-foreground">
                  Ya incluye {dinero(s.descuentos)} en descuentos otorgados.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Caja</p>
              <Linea etiqueta="Cobrado a clientes" valor={dinero(s.cobrado)} />
              {s.creditoAplicado > 0 && (
                <Linea etiqueta="Pagado con crédito de cambios" valor={dinero(s.creditoAplicado)} tenue />
              )}
              <Linea etiqueta="(−) Reembolsos en efectivo" valor={dinero(-s.reembolsadoEfectivo)} tenue />
              <Linea etiqueta="Efectivo neto" valor={dinero(efectivoNeto)} total />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Distribuciones
          titulo="Ventas por día de la semana"
          icono={CalendarRange}
          // Lunes primero
          filas={[1, 2, 3, 4, 5, 6, 0].map((dia) => {
            const d = r.porDiaSemana.find((x) => x.clave === dia);
            return { etiqueta: DIAS_SEMANA_LARGOS[dia], ventas: d?.ventas ?? 0, monto: d?.monto ?? 0 };
          })}
          etiquetaPico="Mejor día"
        />
        <Distribuciones
          titulo="Ventas por hora"
          icono={Clock}
          filas={rangoHoras(r.porHora).map((h) => {
            const d = r.porHora.find((x) => x.clave === h);
            return {
              etiqueta: `${String(h).padStart(2, "0")}:00 – ${String(h + 1).padStart(2, "0")}:00`,
              ventas: d?.ventas ?? 0,
              monto: d?.monto ?? 0,
            };
          })}
          etiquetaPico="Hora pico"
        />
      </div>
    </div>
  );
}

// De la primera a la última hora con ventas (las del medio sin ventas se muestran en 0).
function rangoHoras(datos: Distribucion[]) {
  if (datos.length === 0) return [];
  const min = Math.min(...datos.map((d) => d.clave));
  const max = Math.max(...datos.map((d) => d.clave));
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

function Distribuciones({
  titulo,
  icono: Icono,
  filas,
  etiquetaPico,
}: {
  titulo: string;
  icono: typeof Wallet;
  filas: { etiqueta: string; ventas: number; monto: number }[];
  etiquetaPico: string;
}) {
  const max = Math.max(...filas.map((f) => f.monto), 0);
  const pico = filas.find((f) => f.monto === max && max > 0);
  return (
    <Card size="sm">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Icono className="h-3.5 w-3.5" aria-hidden="true" />
          {titulo}
        </CardTitle>
        {pico && (
          <span className="text-xs text-muted-foreground">
            {etiquetaPico}: <span className="font-medium text-foreground">{pico.etiqueta}</span>
          </span>
        )}
      </CardHeader>
      <CardContent>
        {max === 0 ? (
          <Vacio texto="Sin ventas en este período." />
        ) : (
          <ul className="space-y-1.5">
            {filas.map((f) => (
              <li key={f.etiqueta} className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-3 text-xs">
                <span className="truncate text-muted-foreground tabular-nums">{f.etiqueta}</span>
                <div className="h-2 rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-serie-1"
                    style={{ width: f.monto > 0 ? `${Math.max((f.monto / max) * 100, 2)}%` : 0 }}
                  />
                </div>
                <span className="w-32 text-right tabular-nums">
                  <span className="font-semibold">{dinero(f.monto)}</span>
                  <span className="text-muted-foreground"> · {entero(f.ventas)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// Ventas netas por día o por mes.
function GraficoSerie({ serie, agrupacion }: { serie: PuntoSerie[]; agrupacion: "dia" | "mes" }) {
  // Como mucho ~12 etiquetas en el eje X
  const cadaCuanto = Math.max(1, Math.ceil(serie.length / 12));
  const etiquetaEje = (p: PuntoSerie, i: number) => {
    if (i % cadaCuanto !== 0) return "";
    if (agrupacion === "mes") {
      const [a, m] = p.periodo.split("-").map(Number);
      return i === 0 || m === 1 ? `${MESES[m - 1]} ${String(a).slice(2)}` : MESES[m - 1];
    }
    const f = aFecha(p.periodo);
    return i === 0 || f.getDate() === 1 ? `${f.getDate()} ${MESES[f.getMonth()]}` : String(f.getDate());
  };
  return (
    <GraficoColumnas
      titulo={`Ventas netas ${agrupacion === "mes" ? "por mes" : "por día"}`}
      descripcion="Ventas menos devoluciones, IVA incluido"
      puntos={serie.map((p, i) => ({
        clave: p.periodo,
        valor: p.neto.total,
        etiquetaEje: etiquetaEje(p, i),
        etiquetaLarga: etiquetaPeriodo(p.periodo, agrupacion),
        detalle: (
          <>
            {plural(p.ventas, "venta")}
            {p.devoluciones > 0 && <div>Brutas {dinero(p.ventasBrutas)} · Dev. {dinero(p.devoluciones)}</div>}
          </>
        ),
      }))}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Tabla ordenable reutilizable
// ---------------------------------------------------------------------------------------------

interface Columna<T> {
  id: string;
  titulo: string;
  derecha?: boolean;
  valor?: (fila: T) => number | string; // si existe, la columna se puede ordenar
  celda: (fila: T, indice: number) => React.ReactNode;
  pie?: React.ReactNode;
  className?: string;
}

const FILAS_POR_PAGINA = 50;

function TablaReporte<T>({
  columnas,
  filas,
  ordenInicial,
  clave,
  vacio,
}: {
  columnas: Columna<T>[];
  filas: T[];
  ordenInicial?: { id: string; desc: boolean };
  clave: (fila: T, i: number) => string | number;
  vacio: string;
}) {
  const [orden, setOrden] = useState(ordenInicial);
  const [visibles, setVisibles] = useState(FILAS_POR_PAGINA);

  const ordenadas = useMemo(() => {
    const col = columnas.find((c) => c.id === orden?.id);
    if (!col?.valor || !orden) return filas;
    const valor = col.valor;
    return filas.toSorted((a, b) => {
      const va = valor(a);
      const vb = valor(b);
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "es");
      return orden.desc ? -cmp : cmp;
    });
  }, [filas, orden, columnas]);

  const hayPie = columnas.some((c) => c.pie !== undefined);

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              {columnas.map((c) => {
                const activa = orden?.id === c.id;
                return (
                  <TableHead key={c.id} className={`${c.derecha ? "text-right" : ""} ${c.className ?? ""}`}>
                    {c.valor ? (
                      <button
                        type="button"
                        className={`inline-flex items-center gap-1 hover:text-foreground ${activa ? "text-foreground" : ""}`}
                        onClick={() =>
                          setOrden((o) =>
                            o?.id === c.id ? { id: c.id, desc: !o.desc } : { id: c.id, desc: !!c.derecha }
                          )
                        }
                      >
                        {c.titulo}
                        {activa &&
                          (orden.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                      </button>
                    ) : (
                      c.titulo
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordenadas.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columnas.length} className="py-8 text-center text-xs text-muted-foreground">
                  {vacio}
                </TableCell>
              </TableRow>
            ) : (
              ordenadas.slice(0, visibles).map((f, i) => (
                <TableRow key={clave(f, i)}>
                  {columnas.map((c) => (
                    <TableCell
                      key={c.id}
                      className={`py-1.5 text-xs ${c.derecha ? "text-right tabular-nums" : ""} ${c.className ?? ""}`}
                    >
                      {c.celda(f, i)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
          {hayPie && ordenadas.length > 0 && (
            <TableFooter>
              <TableRow>
                {columnas.map((c) => (
                  <TableCell
                    key={c.id}
                    className={`py-2 text-xs font-semibold ${c.derecha ? "text-right tabular-nums" : ""} ${c.className ?? ""}`}
                  >
                    {c.pie}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </div>
      {ordenadas.length > visibles && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Mostrando {entero(visibles)} de {entero(ordenadas.length)}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => setVisibles((v) => v + FILAS_POR_PAGINA)}>
            Mostrar más
          </Button>
        </div>
      )}
    </div>
  );
}

// Participación con barra fina
function Participacion({ valor, total }: { valor: number; total: number }) {
  const pct = total > 0 ? (valor / total) * 100 : 0;
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="hidden h-1.5 w-16 rounded-full bg-muted sm:block">
        <div className="h-full rounded-full bg-serie-1" style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
      </div>
      <span className="w-12 text-right tabular-nums">{porcentaje(pct)}</span>
    </div>
  );
}

function Buscador({ valor, onCambio, placeholder }: { valor: string; onCambio: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative w-full max-w-xs">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input value={valor} onChange={(e) => onCambio(e.target.value)} placeholder={placeholder} className="pl-8" />
    </div>
  );
}

const coincide = (texto: string, busqueda: string) => {
  const normal = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  const t = normal(texto);
  return normal(busqueda)
    .split(/\s+/)
    .filter(Boolean)
    .every((p) => t.includes(p));
};

// ---------------------------------------------------------------------------------------------
// Productos y categorías
// ---------------------------------------------------------------------------------------------

function PestanaProductos({ r }: { r: Reporte }) {
  const [busqueda, setBusqueda] = useState("");
  const filas = useMemo(
    () => r.productos.filter((p) => coincide(`${p.codigo} ${p.detalle} ${p.categoria}`, busqueda)),
    [r.productos, busqueda]
  );
  const totalNeto = r.productos.reduce((a, p) => a + p.montoNeto, 0);
  const suma = (f: (p: ReporteProducto) => number) => filas.reduce((a, p) => a + f(p), 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar código, producto o categoría" />
        <p className="text-xs text-muted-foreground">
          {entero(r.productos.length)} productos con movimiento · montos sin IVA, netos de descuentos y devoluciones
        </p>
      </div>
      <TablaReporte
        filas={filas}
        // El backend agrupa por producto: dos productos (uno ya eliminado) pueden compartir código
        clave={(p, i) => `${p.codigo}-${p.detalle}-${i}`}
        ordenInicial={{ id: "monto", desc: true }}
        vacio={busqueda ? "Ningún producto coincide con la búsqueda." : "No hubo ventas en este período."}
        columnas={[
          { id: "pos", titulo: "#", celda: (_, i) => <span className="text-muted-foreground">{i + 1}</span>, className: "w-8" },
          { id: "codigo", titulo: "Código", valor: (p) => p.codigo, celda: (p) => <span className="font-mono">{p.codigo}</span> },
          {
            id: "detalle",
            titulo: "Producto",
            valor: (p) => p.detalle,
            celda: (p) => <span className="uppercase">{p.detalle}</span>,
            pie: `Total (${entero(filas.length)})`,
          },
          {
            id: "categoria",
            titulo: "Categoría",
            valor: (p) => p.categoria,
            celda: (p) => <span className="text-muted-foreground">{p.categoria || "—"}</span>,
          },
          { id: "ventas", titulo: "Ventas", derecha: true, valor: (p) => p.ventas, celda: (p) => entero(p.ventas) },
          {
            id: "vendidas",
            titulo: "Vendidas",
            derecha: true,
            valor: (p) => p.unidadesVendidas,
            celda: (p) => entero(p.unidadesVendidas),
            pie: entero(suma((p) => p.unidadesVendidas)),
          },
          {
            id: "devueltas",
            titulo: "Devueltas",
            derecha: true,
            valor: (p) => p.unidadesDevueltas,
            celda: (p) =>
              p.unidadesDevueltas > 0 ? (
                <span className="text-amber-600 dark:text-amber-400">{entero(p.unidadesDevueltas)}</span>
              ) : (
                <span className="text-muted-foreground">0</span>
              ),
            pie: entero(suma((p) => p.unidadesDevueltas)),
          },
          {
            id: "netas",
            titulo: "Netas",
            derecha: true,
            valor: (p) => p.unidadesVendidas - p.unidadesDevueltas,
            celda: (p) => <span className="font-medium">{entero(p.unidadesVendidas - p.unidadesDevueltas)}</span>,
            pie: entero(suma((p) => p.unidadesVendidas - p.unidadesDevueltas)),
          },
          {
            id: "monto",
            titulo: "Venta neta",
            derecha: true,
            valor: (p) => p.montoNeto,
            celda: (p) => <span className="font-semibold">{dinero(p.montoNeto)}</span>,
            pie: dinero(m2(suma((p) => p.montoNeto))),
          },
          {
            id: "part",
            titulo: "Participación",
            derecha: true,
            valor: (p) => p.montoNeto,
            celda: (p) => <Participacion valor={p.montoNeto} total={totalNeto} />,
          },
        ]}
      />
    </div>
  );
}

function PestanaCategorias({ categorias }: { categorias: ReporteCategoria[] }) {
  const total = categorias.reduce((a, c) => a + c.montoNeto, 0);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Agrupado por la categoría actual de cada producto · montos sin IVA, netos de descuentos y devoluciones
      </p>
      <TablaReporte
        filas={categorias}
        clave={(c) => c.categoria}
        ordenInicial={{ id: "monto", desc: true }}
        vacio="No hubo ventas en este período."
        columnas={[
          {
            id: "categoria",
            titulo: "Categoría",
            valor: (c) => c.categoria,
            celda: (c) => <span className="font-medium uppercase">{c.categoria}</span>,
            pie: "Total",
          },
          {
            id: "productos",
            titulo: "Productos",
            derecha: true,
            valor: (c) => c.productos,
            celda: (c) => entero(c.productos),
            pie: entero(categorias.reduce((a, c) => a + c.productos, 0)),
          },
          {
            id: "unidades",
            titulo: "Unidades netas",
            derecha: true,
            valor: (c) => c.unidades,
            celda: (c) => entero(c.unidades),
            pie: entero(categorias.reduce((a, c) => a + c.unidades, 0)),
          },
          {
            id: "monto",
            titulo: "Venta neta",
            derecha: true,
            valor: (c) => c.montoNeto,
            celda: (c) => <span className="font-semibold">{dinero(c.montoNeto)}</span>,
            pie: dinero(m2(total)),
          },
          {
            id: "part",
            titulo: "Participación",
            derecha: true,
            valor: (c) => c.montoNeto,
            celda: (c) => <Participacion valor={c.montoNeto} total={total} />,
            pie: total !== 0 ? "100.0%" : "",
          },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------------------------

function PestanaClientes({ r }: { r: Reporte }) {
  const [busqueda, setBusqueda] = useState("");
  const filas = useMemo(
    () => r.clientes.filter((c) => coincide(`${c.nombre} ${c.identificacion}`, busqueda)),
    [r.clientes, busqueda]
  );
  const totalNeto = r.clientes.reduce((a, c) => a + c.neto, 0);
  const suma = (f: (c: ReporteCliente) => number) => filas.reduce((a, c) => a + f(c), 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar cliente o identificación" />
        <p className="text-xs text-muted-foreground">Montos con IVA · ventas sin cliente = consumidor final</p>
      </div>
      <TablaReporte
        filas={filas}
        clave={(c, i) => `${c.identificacion}-${c.nombre}-${i}`}
        ordenInicial={{ id: "neto", desc: true }}
        vacio={busqueda ? "Ningún cliente coincide con la búsqueda." : "No hubo ventas en este período."}
        columnas={[
          {
            id: "nombre",
            titulo: "Cliente",
            valor: (c) => c.nombre,
            celda: (c) => <span className="font-medium uppercase">{c.nombre}</span>,
            pie: `Total (${entero(filas.length)})`,
          },
          {
            id: "ident",
            titulo: "Identificación",
            valor: (c) => c.identificacion,
            celda: (c) => <span className="font-mono text-muted-foreground">{c.identificacion || "—"}</span>,
          },
          {
            id: "compras",
            titulo: "Compras",
            derecha: true,
            valor: (c) => c.compras,
            celda: (c) => entero(c.compras),
            pie: entero(suma((c) => c.compras)),
          },
          {
            id: "total",
            titulo: "Total compras",
            derecha: true,
            valor: (c) => c.totalCompras,
            celda: (c) => dinero(c.totalCompras),
            pie: dinero(m2(suma((c) => c.totalCompras))),
          },
          {
            id: "dev",
            titulo: "Devoluciones",
            derecha: true,
            valor: (c) => c.devoluciones,
            celda: (c) =>
              c.devoluciones > 0 ? (
                <span className="text-amber-600 dark:text-amber-400">{dinero(-c.devoluciones)}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
            pie: dinero(-m2(suma((c) => c.devoluciones))),
          },
          {
            id: "neto",
            titulo: "Neto",
            derecha: true,
            valor: (c) => c.neto,
            celda: (c) => <span className="font-semibold">{dinero(c.neto)}</span>,
            pie: dinero(m2(suma((c) => c.neto))),
          },
          {
            id: "promedio",
            titulo: "Ticket prom.",
            derecha: true,
            valor: (c) => (c.compras > 0 ? c.totalCompras / c.compras : 0),
            celda: (c) => (c.compras > 0 ? dinero(c.totalCompras / c.compras) : "—"),
          },
          {
            id: "ultima",
            titulo: "Última compra",
            valor: (c) => c.ultimaCompra ?? "",
            celda: (c) => <span className="text-muted-foreground">{c.ultimaCompra ? fechaTexto(c.ultimaCompra) : "—"}</span>,
          },
          {
            id: "part",
            titulo: "Participación",
            derecha: true,
            valor: (c) => c.neto,
            celda: (c) => <Participacion valor={c.neto} total={totalNeto} />,
          },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Impuestos
// ---------------------------------------------------------------------------------------------

function PestanaImpuestos({ r }: { r: Reporte }) {
  const v = r.impuestosVentas;
  const d = r.impuestosDevoluciones;
  const n = r.impuestosNeto;
  const base = (x: Desglose) => m2(x.subtotalCero + x.subtotalIva5 + x.subtotalIva15);
  const conMovimiento = r.serie.filter((p) => p.ventas > 0 || p.devoluciones > 0);

  const filasDesglose: { concepto: string; v: number; d: number; n: number; fuerte?: boolean; tenue?: boolean }[] = [
    { concepto: "Base tarifa 0%", v: v.subtotalCero, d: d.subtotalCero, n: n.subtotalCero, tenue: true },
    { concepto: "Base tarifa 5%", v: v.subtotalIva5, d: d.subtotalIva5, n: n.subtotalIva5, tenue: true },
    { concepto: "Base tarifa 15%", v: v.subtotalIva15, d: d.subtotalIva15, n: n.subtotalIva15, tenue: true },
    { concepto: "Subtotal (bases imponibles)", v: base(v), d: base(d), n: base(n), fuerte: true },
    { concepto: "IVA 5%", v: v.iva5, d: d.iva5, n: n.iva5, tenue: true },
    { concepto: "IVA 15%", v: v.iva15, d: d.iva15, n: n.iva15, tenue: true },
    { concepto: "Total IVA", v: m2(v.iva5 + v.iva15), d: m2(d.iva5 + d.iva15), n: m2(n.iva5 + n.iva15), fuerte: true },
    { concepto: "Total", v: v.total, d: d.total, n: n.total, fuerte: true },
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Indicador titulo="Base imponible neta" icono={Receipt} valor={dinero(base(n))} pie="Tarifas 0%, 5% y 15%" />
        <Indicador titulo="IVA generado neto" icono={Wallet} valor={dinero(m2(n.iva5 + n.iva15))} pie="IVA de ventas − IVA de devoluciones" />
        <Indicador titulo="Total facturado neto" icono={Hash} valor={dinero(n.total)} pie="Base + IVA" />
      </div>

      <div className="grid gap-3 xl:grid-cols-5">
        <Card size="sm" className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Desglose por tarifa</CardTitle>
            <CardDescription>Referencia para la declaración de IVA; verifica con tu contador.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>Concepto</TableHead>
                    <TableHead className="text-right">Ventas</TableHead>
                    <TableHead className="text-right">Devol.</TableHead>
                    <TableHead className="text-right">Neto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filasDesglose.map((f) => (
                    <TableRow key={f.concepto} className={f.fuerte ? "bg-muted/30 font-semibold" : ""}>
                      <TableCell className={`py-1.5 text-xs ${f.tenue ? "pl-4 text-muted-foreground" : ""}`}>{f.concepto}</TableCell>
                      <TableCell className="py-1.5 text-right text-xs tabular-nums">{dinero(f.v)}</TableCell>
                      <TableCell className="py-1.5 text-right text-xs tabular-nums text-muted-foreground">
                        {f.d ? dinero(-f.d) : "—"}
                      </TableCell>
                      <TableCell className={`py-1.5 text-right text-xs tabular-nums ${f.concepto === "Total" ? "text-primary" : ""}`}>
                        {dinero(f.n)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card size="sm" className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Neto {r.agrupacion === "mes" ? "por mes" : "por día"}</CardTitle>
            <CardDescription>Solo períodos con movimiento</CardDescription>
          </CardHeader>
          <CardContent>
            <TablaReporte
              filas={conMovimiento}
              clave={(p) => p.periodo}
              vacio="Sin movimiento en este período."
              columnas={[
                {
                  id: "periodo",
                  titulo: r.agrupacion === "mes" ? "Mes" : "Día",
                  celda: (p) => <span className="capitalize">{etiquetaPeriodo(p.periodo, r.agrupacion)}</span>,
                  pie: "Total",
                },
                { id: "b0", titulo: "Base 0%", derecha: true, celda: (p) => dinero(p.neto.subtotalCero), pie: dinero(n.subtotalCero) },
                { id: "b5", titulo: "Base 5%", derecha: true, celda: (p) => dinero(p.neto.subtotalIva5), pie: dinero(n.subtotalIva5) },
                { id: "b15", titulo: "Base 15%", derecha: true, celda: (p) => dinero(p.neto.subtotalIva15), pie: dinero(n.subtotalIva15) },
                {
                  id: "iva",
                  titulo: "IVA",
                  derecha: true,
                  celda: (p) => dinero(m2(p.neto.iva5 + p.neto.iva15)),
                  pie: dinero(m2(n.iva5 + n.iva15)),
                },
                {
                  id: "total",
                  titulo: "Total",
                  derecha: true,
                  celda: (p) => <span className="font-semibold">{dinero(p.neto.total)}</span>,
                  pie: dinero(n.total),
                },
              ]}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Devoluciones
// ---------------------------------------------------------------------------------------------

function PestanaDevoluciones({ r }: { r: Reporte }) {
  const s = r.resumen;
  const porCambio = m2(s.montoDevuelto - s.reembolsadoEfectivo);
  const tasa = s.ventasBrutas > 0 ? (s.montoDevuelto / s.ventasBrutas) * 100 : 0;

  const motivos = useMemo(() => {
    const mapa = new Map<string, { motivo: string; cantidad: number; total: number }>();
    for (const d of r.devoluciones) {
      const m = mapa.get(d.motivo) ?? { motivo: d.motivo, cantidad: 0, total: 0 };
      m.cantidad += 1;
      m.total = m2(m.total + d.total);
      mapa.set(d.motivo, m);
    }
    return [...mapa.values()].sort((a, b) => b.total - a.total);
  }, [r.devoluciones]);
  const maxMotivo = Math.max(...motivos.map((m) => m.total), 0);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Indicador
          titulo="Total devuelto"
          icono={Undo2}
          valor={dinero(s.montoDevuelto)}
          junto={`${entero(s.devoluciones)} devoluci${s.devoluciones === 1 ? "ón" : "ones"}`}
          pie={<Variacion actual={s.montoDevuelto} anterior={r.anterior.montoDevuelto} />}
        />
        <Indicador titulo="Tasa de devolución" icono={Hash} valor={porcentaje(tasa)} pie="Sobre las ventas brutas del período" />
        <Indicador titulo="Reembolsado en efectivo" icono={Wallet} valor={dinero(s.reembolsadoEfectivo)} pie="Dinero que salió de caja" />
        <Indicador titulo="Por cambio de producto" icono={RefreshCw} valor={dinero(porCambio)} pie="Crédito para otra venta" />
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Por motivo</CardTitle>
          </CardHeader>
          <CardContent>
            {motivos.length === 0 ? (
              <Vacio texto="No hubo devoluciones en este período." />
            ) : (
              <ul className="space-y-2.5">
                {motivos.map((m) => (
                  <li key={m.motivo} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="min-w-0 truncate uppercase">{m.motivo}</span>
                      <span className="shrink-0 tabular-nums">
                        <span className="font-semibold">{dinero(m.total)}</span>
                        <span className="text-muted-foreground"> · {entero(m.cantidad)}</span>
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-serie-1"
                        style={{ width: `${Math.max((m.total / maxMotivo) * 100, 2)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="xl:col-span-2">
          <TablaReporte
            filas={r.devoluciones}
            clave={(d) => d.id}
            ordenInicial={{ id: "fecha", desc: true }}
            vacio="No hubo devoluciones en este período."
            columnas={[
              { id: "id", titulo: "N.º", valor: (d) => d.id, celda: (d) => <span className="font-mono font-semibold">{d.id}</span> },
              { id: "fecha", titulo: "Fecha", valor: (d) => d.fecha, celda: (d) => fechaHora(d.fecha) },
              {
                id: "venta",
                titulo: "Venta",
                valor: (d) => d.ventaId,
                celda: (d) => <span className="font-mono text-muted-foreground">N.º {d.ventaId}</span>,
              },
              {
                id: "cliente",
                titulo: "Cliente",
                valor: (d) => d.clienteNombre,
                celda: (d) => <span className="uppercase">{d.clienteNombre || "Consumidor final"}</span>,
              },
              {
                id: "motivo",
                titulo: "Motivo",
                valor: (d) => d.motivo,
                celda: (d) => <span className="uppercase text-muted-foreground">{d.motivo}</span>,
              },
              {
                id: "reembolso",
                titulo: "Reembolso",
                valor: (d) => d.reembolso,
                celda: (d) => (d.reembolso === "EFECTIVO" ? "Efectivo" : "Cambio"),
              },
              { id: "unidades", titulo: "U.", derecha: true, valor: (d) => d.unidades, celda: (d) => entero(d.unidades) },
              {
                id: "total",
                titulo: "Total",
                derecha: true,
                valor: (d) => d.total,
                celda: (d) => <span className="font-semibold">{dinero(d.total)}</span>,
                pie: dinero(s.montoDevuelto),
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Varios
// ---------------------------------------------------------------------------------------------

function ReporteSkeleton() {
  return (
    <div className="space-y-3 pt-2" aria-busy="true" aria-label="Cargando">
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
      <Card size="sm">
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
