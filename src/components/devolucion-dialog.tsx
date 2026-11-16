import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Minus, Plus } from "lucide-react";
import { aMayusculas } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Debe coincidir con struct Devolucion en src-tauri/src/lib.rs
export interface Devolucion {
  id: number;
  ventaId: number;
  fecha: string;
  motivo: string;
  reembolso: Reembolso;
  subtotalCero: number;
  subtotalIva5: number;
  subtotalIva15: number;
  iva5: number;
  iva15: number;
  total: number;
  unidades: number;
  usadaEnVenta: number | null; // venta donde se aplicó el crédito (solo CAMBIO)
}

// Línea de la venta original, con lo que ya se devolvió antes.
export interface LineaVentaDevolucion {
  id: number;
  codigo: string;
  detalle: string;
  cantidad: number;
  iva: string;
  subtotal: number;
  devuelto: number;
}

// Debe coincidir con REEMBOLSOS en src-tauri/src/lib.rs
export type Reembolso = "EFECTIVO" | "CAMBIO";
export const ETIQUETAS_REEMBOLSO: Record<Reembolso, string> = {
  EFECTIVO: "Reembolso en efectivo",
  CAMBIO: "Crédito para cambio",
};

const MOTIVOS_SUGERIDOS = ["PRODUCTO DEFECTUOSO", "MEDIDA O MODELO EQUIVOCADO", "NO LE SIRVIÓ AL CLIENTE", "CAMBIO DE PRODUCTO"];
// Motivos que casi siempre terminan en cambio: al elegirlos se preselecciona "Cambio de producto".
const MOTIVOS_DE_CAMBIO = ["MEDIDA O MODELO EQUIVOCADO", "CAMBIO DE PRODUCTO"];

// Cambio directo: tras registrar, ir a la venta con el crédito aplicado y el buscador listo.
export interface CambioDirecto {
  busqueda: string; // detalle del producto devuelto, para mostrar sus otras medidas o modelos
}

const PORCENTAJE_IVA: Record<string, number> = { IVA_15: 15, IVA_5: 5 };
const aCentavos = (valor: number) => Math.round(valor * 100);
const formatear = (centavos: number) => `$${(centavos / 100).toFixed(2)}`;
const calcularIva = (base: number, porcentaje: number) => Math.floor((base * porcentaje + 50) / 100);
const proporcion = (total: number, parte: number, de: number) =>
  de <= 0 ? 0 : Math.floor((total * parte * 2 + de) / (2 * de));

interface Seleccion {
  cantidad: number;
  regresaStock: boolean;
}

// Vista previa del importe a devolver. Debe coincidir con registrar_devolucion en src-tauri/src/lib.rs
// (subtotal proporcional acumulado e IVA acumulado sobre lo ya devuelto).
function calcularDevolucion(lineas: LineaVentaDevolucion[], seleccion: Record<number, Seleccion>, previas: Devolucion[]) {
  let subCero = 0;
  let subIva5 = 0;
  let subIva15 = 0;
  for (const l of lineas) {
    const cant = seleccion[l.id]?.cantidad ?? 0;
    if (cant <= 0) continue;
    const sub = aCentavos(l.subtotal);
    const parte = proporcion(sub, l.devuelto + cant, l.cantidad) - proporcion(sub, l.devuelto, l.cantidad);
    const pct = PORCENTAJE_IVA[l.iva] ?? 0;
    if (pct === 15) subIva15 += parte;
    else if (pct === 5) subIva5 += parte;
    else subCero += parte;
  }
  const suma = (f: (d: Devolucion) => number) => previas.reduce((acc, d) => acc + aCentavos(f(d)), 0);
  const iva5 = Math.max(0, calcularIva(suma((d) => d.subtotalIva5) + subIva5, 5) - suma((d) => d.iva5));
  const iva15 = Math.max(0, calcularIva(suma((d) => d.subtotalIva15) + subIva15, 15) - suma((d) => d.iva15));
  return { subCero, subIva5, subIva15, iva5, iva15, total: subCero + subIva5 + subIva15 + iva5 + iva15 };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ventaId: number;
  lineas: LineaVentaDevolucion[];
  devolucionesPrevias: Devolucion[];
  // `cambio` viene solo si se eligió "Registrar y elegir producto nuevo".
  onRegistrada: (devolucion: Devolucion, cambio?: CambioDirecto) => void;
}

export function DevolucionDialog({ open, onOpenChange, ventaId, lineas, devolucionesPrevias, onRegistrada }: Props) {
  const [seleccion, setSeleccion] = useState<Record<number, Seleccion>>({});
  const [motivo, setMotivo] = useState("");
  const [reembolso, setReembolso] = useState<Reembolso>("EFECTIVO");
  const [error, setError] = useState("");
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSeleccion({});
    setMotivo("");
    setReembolso("EFECTIVO");
    setError("");
  }, [open]);

  const disponibles = lineas.filter((l) => l.cantidad - l.devuelto > 0);
  const calc = useMemo(
    () => calcularDevolucion(lineas, seleccion, devolucionesPrevias),
    [lineas, seleccion, devolucionesPrevias],
  );
  const unidades = Object.values(seleccion).reduce((acc, s) => acc + s.cantidad, 0);

  const cambiar = (linea: LineaVentaDevolucion, cambios: Partial<Seleccion>) => {
    setError("");
    setSeleccion((prev) => {
      const actual = prev[linea.id] ?? { cantidad: 0, regresaStock: true };
      const nueva = { ...actual, ...cambios };
      nueva.cantidad = Math.min(Math.max(0, nueva.cantidad), linea.cantidad - linea.devuelto);
      return { ...prev, [linea.id]: nueva };
    });
  };

  const devolverTodo = () => {
    setError("");
    setSeleccion(
      Object.fromEntries(
        disponibles.map((l) => [l.id, { cantidad: l.cantidad - l.devuelto, regresaStock: seleccion[l.id]?.regresaStock ?? true }]),
      ),
    );
  };

  const registrar = async (cambiarAhora: boolean) => {
    setError("");
    if (unidades === 0) {
      setError("Elige al menos un producto a devolver.");
      return;
    }
    if (!motivo.trim()) {
      setError("Indica el motivo de la devolución.");
      return;
    }
    setGuardando(true);
    try {
      const devolucion: Devolucion = await invoke("registrar_devolucion", {
        ventaId,
        items: Object.entries(seleccion)
          .filter(([, s]) => s.cantidad > 0)
          .map(([id, s]) => ({ ventaDetalleId: Number(id), cantidad: s.cantidad, regresaStock: s.regresaStock })),
        motivo: motivo.trim(),
        reembolso,
      });
      if (cambiarAhora && devolucion.reembolso === "CAMBIO") {
        const devuelta = lineas.find((l) => (seleccion[l.id]?.cantidad ?? 0) > 0);
        onRegistrada(devolucion, { busqueda: devuelta?.detalle ?? "" });
      } else {
        onRegistrada(devolucion);
      }
    } catch (err) {
      console.error("Error al registrar la devolución:", err);
      setError(typeof err === "string" ? err : "No se pudo registrar la devolución.");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Devolución de la venta N.º {ventaId}</DialogTitle>
          <DialogDescription>
            Elige qué se devuelve. Si el producto está dañado, desactiva "Regresa a stock".
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="max-h-64 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Producto</TableHead>
                  <TableHead className="text-right">Vendido</TableHead>
                  <TableHead className="text-center">Devolver</TableHead>
                  <TableHead className="text-center">Regresa a stock</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lineas.map((l) => {
                  const max = l.cantidad - l.devuelto;
                  const sel = seleccion[l.id] ?? { cantidad: 0, regresaStock: true };
                  return (
                    <TableRow key={l.id} className={max === 0 ? "opacity-50" : ""}>
                      <TableCell className="text-sm uppercase">
                        <div className="font-medium">{l.detalle}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{l.codigo}</div>
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {l.cantidad}
                        {l.devuelto > 0 && (
                          <div className="text-[11px] text-muted-foreground">ya devuelto: {l.devuelto}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        {max === 0 ? (
                          <p className="text-center text-xs text-muted-foreground">Devuelto</p>
                        ) : (
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              disabled={sel.cantidad <= 0}
                              onClick={() => cambiar(l, { cantidad: sel.cantidad - 1 })}
                              aria-label={`Devolver una unidad menos de ${l.detalle}`}
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </Button>
                            <span className="w-12 text-center text-sm tabular-nums">
                              {sel.cantidad} / {max}
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              disabled={sel.cantidad >= max}
                              onClick={() => cambiar(l, { cantidad: sel.cantidad + 1 })}
                              aria-label={`Devolver una unidad más de ${l.detalle}`}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {max > 0 && (
                          <Switch
                            checked={sel.regresaStock}
                            onCheckedChange={(v) => cambiar(l, { regresaStock: v })}
                            aria-label={`${l.detalle} regresa a stock`}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <Button type="button" variant="outline" size="sm" onClick={devolverTodo} disabled={disponibles.length === 0}>
            Devolver todo lo pendiente
          </Button>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="motivo-devolucion">Motivo</Label>
                <Input
                  id="motivo-devolucion"
                  list="motivos-devolucion"
                  placeholder="Ej. PRODUCTO DEFECTUOSO"
                  value={motivo}
                  maxLength={200}
                  onChange={(e) => {
                    const valor = aMayusculas(e);
                    setMotivo(valor);
                    if (MOTIVOS_DE_CAMBIO.includes(valor.trim())) setReembolso("CAMBIO");
                    setError("");
                  }}
                />
                <datalist id="motivos-devolucion">
                  {MOTIVOS_SUGERIDOS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-1">
                <Label>Reembolso</Label>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(ETIQUETAS_REEMBOLSO) as Reembolso[]).map((r) => (
                    <Button
                      key={r}
                      type="button"
                      variant={reembolso === r ? "default" : "outline"}
                      size="sm"
                      onClick={() => setReembolso(r)}
                      aria-pressed={reembolso === r}
                    >
                      {r === "EFECTIVO" ? "Efectivo" : "Cambio de producto"}
                    </Button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {reembolso === "EFECTIVO"
                    ? "Se entrega el dinero al cliente."
                    : "El monto queda como crédito y se descuenta al cobrar los productos nuevos."}
                </p>
              </div>
            </div>

            <div className="space-y-1.5 text-sm">
              <Fila etiqueta="Subtotal 0%" valor={calc.subCero} />
              {calc.subIva5 > 0 && <Fila etiqueta="Subtotal 5%" valor={calc.subIva5} />}
              <Fila etiqueta="Subtotal 15%" valor={calc.subIva15} />
              {calc.iva5 > 0 && <Fila etiqueta="IVA 5%" valor={calc.iva5} />}
              <Fila etiqueta="IVA 15%" valor={calc.iva15} />
              <Separator className="my-2" />
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{reembolso === "EFECTIVO" ? "A devolver" : "Crédito"}</span>
                <span className="text-2xl font-extrabold tabular-nums">{formatear(calc.total)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {unidades} unidad{unidades === 1 ? "" : "es"}
              </p>
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          {reembolso === "CAMBIO" ? (
            <>
              <Button type="button" variant="outline" disabled={guardando || unidades === 0} onClick={() => registrar(false)}>
                Solo registrar crédito
              </Button>
              <Button type="button" disabled={guardando || unidades === 0} onClick={() => registrar(true)}>
                {guardando ? "Registrando..." : `Registrar y elegir producto nuevo (${formatear(calc.total)})`}
              </Button>
            </>
          ) : (
            <Button type="button" disabled={guardando || unidades === 0} onClick={() => registrar(false)}>
              {guardando ? "Registrando..." : `Registrar devolución ${formatear(calc.total)}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Fila({ etiqueta, valor }: { etiqueta: string; valor: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-muted-foreground">{etiqueta}</span>
      <span className="tabular-nums">{formatear(valor)}</span>
    </div>
  );
}
