// Piezas compartidas entre el Panel principal y Reportes: formatos, indicadores, variaciones y el
// gráfico de columnas. Mantienen las dos pantallas con el mismo lenguaje visual.
import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// ---------------------------------------------------------------------------------------------
// Formatos
// ---------------------------------------------------------------------------------------------

const formatoDinero = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatoEntero = new Intl.NumberFormat("en-US");

export const dinero = (v: number) => `${v < 0 ? "−" : ""}$${formatoDinero.format(Math.abs(v))}`;
export const entero = (v: number) => formatoEntero.format(v);
export const porcentaje = (v: number) => `${v.toFixed(1)}%`;
// Redondea a centavos (para sumas hechas en el frontend)
export const m2 = (v: number) => Math.round(v * 100) / 100;
export const plural = (n: number, singular: string, enPlural = `${singular}s`) =>
  `${entero(n)} ${n === 1 ? singular : enPlural}`;

export const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
export const MESES_LARGOS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
export const DIAS_SEMANA = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
export const DIAS_SEMANA_LARGOS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

// Date local -> "AAAA-MM-DD"
export const aISO = (f: Date) =>
  `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, "0")}-${String(f.getDate()).padStart(2, "0")}`;

// "2026-11-06" -> Date local (sin desfase de zona horaria)
export function aFecha(texto: string) {
  const [a, m, d] = texto.slice(0, 10).split("-").map(Number);
  return new Date(a, (m || 1) - 1, d || 1);
}

// "2026-11-06" -> "6 nov 2026"
export function fechaTexto(texto: string, conAnio = true) {
  const f = aFecha(texto);
  return `${f.getDate()} ${MESES[f.getMonth()]}${conAnio ? ` ${f.getFullYear()}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Indicadores
// ---------------------------------------------------------------------------------------------

export function Indicador({
  titulo,
  icono: Icono,
  valor,
  junto,
  pie,
  onClick,
  activo = false,
}: {
  titulo: string;
  icono: LucideIcon;
  valor: string;
  junto?: string;
  pie?: React.ReactNode;
  // Si se pasa, la tarjeta funciona como botón (p. ej. para filtrar una tabla)
  onClick?: () => void;
  activo?: boolean;
}) {
  const tarjeta = (
    <Card
      size="sm"
      className={
        onClick
          ? `h-full transition-colors hover:bg-muted/50 ${activo ? "ring-2 ring-primary" : ""}`
          : undefined
      }
    >
      <CardContent className="space-y-1">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate font-medium">{titulo}</span>
          <Icono className="h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden="true" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-extrabold tracking-tight tabular-nums">{valor}</span>
          {junto && <span className="truncate text-xs text-muted-foreground">{junto}</span>}
        </div>
        {pie && <div className="truncate text-xs text-muted-foreground">{pie}</div>}
      </CardContent>
    </Card>
  );
  if (!onClick) return tarjeta;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={activo}
      className="rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {tarjeta}
    </button>
  );
}

// Variación contra otro período. Flecha + texto (nunca solo color).
export function Variacion({
  actual,
  anterior,
  contra = "vs. período anterior",
  sinDatos = "Sin datos del período anterior",
}: {
  actual: number;
  anterior: number;
  contra?: string;
  sinDatos?: string;
}) {
  if (anterior === 0) {
    return <>{actual === 0 ? "Sin movimiento en ambos períodos" : sinDatos}</>;
  }
  const v = ((actual - anterior) / Math.abs(anterior)) * 100;
  const sube = v >= 0;
  const Icono = sube ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1">
      <Icono
        className={`h-3.5 w-3.5 ${sube ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
        aria-hidden="true"
      />
      <span className="font-medium text-foreground">
        {sube ? "+" : "−"}
        {Math.abs(v).toFixed(1)}%
      </span>
      {contra}
    </span>
  );
}

// Fila de un estado de cuenta: etiqueta a la izquierda, monto a la derecha. `total` la destaca.
export function Linea({
  etiqueta,
  valor,
  tenue,
  total,
}: {
  etiqueta: string;
  valor: string;
  tenue?: boolean;
  total?: boolean;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${total ? "border-t pt-1.5 font-semibold" : ""}`}>
      <span className={tenue ? "text-muted-foreground" : ""}>{etiqueta}</span>
      <span className={`tabular-nums ${total ? "text-primary" : tenue ? "text-muted-foreground" : ""}`}>{valor}</span>
    </div>
  );
}

export function Vacio({ texto }: { texto: string }) {
  return <p className="py-6 text-center text-xs text-muted-foreground">{texto}</p>;
}

// ---------------------------------------------------------------------------------------------
// Gráfico de columnas (una sola serie: sin leyenda, el título la nombra)
// ---------------------------------------------------------------------------------------------

export interface PuntoColumna {
  clave: string;
  valor: number;
  etiquetaEje: string; // texto corto bajo la columna ("" para no mostrar)
  etiquetaLarga: string; // título del tooltip y del aria-label
  detalle?: React.ReactNode; // líneas extra del tooltip
  destacado?: boolean; // etiqueta del eje en negrita (p. ej. "Hoy")
}

// Escala "redonda" para el eje Y (0, 50, 100, 150...).
function escalaY(maximo: number) {
  if (maximo <= 0) return { tope: 1, marcas: [0] };
  const bruto = maximo / 3;
  const potencia = 10 ** Math.floor(Math.log10(bruto));
  const n = bruto / potencia;
  const paso = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * potencia;
  const tope = Math.ceil(maximo / paso) * paso;
  const marcas: number[] = [];
  for (let v = 0; v <= tope + paso / 2; v += paso) marcas.push(v);
  return { tope, marcas };
}

const etiquetaEjeY = (v: number) => (v >= 10000 ? `$${entero(Math.round(v / 1000))}K` : `$${entero(v)}`);

export function GraficoColumnas({
  titulo,
  descripcion,
  accion,
  puntos,
  alto = "h-48",
}: {
  titulo: React.ReactNode;
  descripcion?: React.ReactNode;
  accion?: React.ReactNode;
  puntos: PuntoColumna[];
  alto?: string;
}) {
  const [activo, setActivo] = useState<number | null>(null);
  const maximo = Math.max(...puntos.map((p) => p.valor), 0);
  const { tope, marcas } = escalaY(maximo);
  const indiceMaximo = maximo > 0 ? puntos.findIndex((p) => p.valor === maximo) : -1;

  return (
    <Card size="sm" className="h-full">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="space-y-1">
          <CardTitle>{titulo}</CardTitle>
          {descripcion && <CardDescription>{descripcion}</CardDescription>}
        </div>
        {accion}
      </CardHeader>
      <CardContent>
        <div className={`relative ml-12 ${alto}`}>
          {marcas.map((m) => (
            <div
              key={m}
              className="pointer-events-none absolute inset-x-0 border-t border-border"
              style={{ bottom: `${(m / tope) * 100}%` }}
            >
              <span className="absolute -left-12 w-10 -translate-y-1/2 text-right text-[10px] text-muted-foreground tabular-nums">
                {etiquetaEjeY(m)}
              </span>
            </div>
          ))}
          {maximo === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-xs text-muted-foreground">Sin ventas en este período.</p>
            </div>
          )}
          <div className="absolute inset-0 flex items-end" onMouseLeave={() => setActivo(null)}>
            {puntos.map((p, i) => {
              const altura = Math.max(0, (p.valor / tope) * 100);
              const esActivo = activo === i;
              return (
                <div
                  key={p.clave}
                  className="relative flex h-full flex-1 items-end justify-center"
                  onMouseEnter={() => setActivo(i)}
                  onFocus={() => setActivo(i)}
                  onBlur={() => setActivo(null)}
                  tabIndex={0}
                  role="img"
                  aria-label={`${p.etiquetaLarga}: ${dinero(p.valor)}`}
                >
                  {esActivo && <div className="absolute inset-0 rounded-sm bg-muted/60" />}
                  {altura > 0 && (
                    <div
                      className={`relative w-full max-w-6 rounded-t-[3px] bg-serie-1 transition-[height,opacity] duration-500 ease-out ${
                        activo !== null && !esActivo ? "opacity-60" : ""
                      }`}
                      style={{ height: `${altura}%`, marginInline: puntos.length > 40 ? 0.5 : 2 }}
                    />
                  )}
                  {/* Etiqueta solo en la columna más alta */}
                  {i === indiceMaximo && activo === null && (
                    <span
                      className="pointer-events-none absolute whitespace-nowrap text-[10px] font-semibold text-foreground tabular-nums"
                      style={{ bottom: `calc(${altura}% + 3px)` }}
                    >
                      {dinero(p.valor)}
                    </span>
                  )}
                  {esActivo && (
                    <div
                      className="pointer-events-none absolute z-10 w-max rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
                      style={{
                        bottom: `calc(${Math.min(altura, 65)}% + 8px)`,
                        left: "50%",
                        // Evita que se salga por los bordes en las primeras y últimas columnas
                        transform: `translateX(${
                          i < puntos.length * 0.15 ? "-10%" : i > puntos.length * 0.85 ? "-90%" : "-50%"
                        })`,
                      }}
                    >
                      <div className="font-medium capitalize">{p.etiquetaLarga}</div>
                      <div className="font-semibold tabular-nums">{dinero(p.valor)}</div>
                      {p.detalle && <div className="text-muted-foreground tabular-nums">{p.detalle}</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="ml-12 mt-1 flex">
          {puntos.map((p) => (
            <div
              key={p.clave}
              className={`flex-1 text-center text-[10px] tabular-nums ${
                p.destacado ? "font-semibold text-foreground" : "text-muted-foreground"
              }`}
            >
              {p.etiquetaEje}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
