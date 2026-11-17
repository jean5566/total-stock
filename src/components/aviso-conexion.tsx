import { useState } from "react";
import { AlertTriangle, CheckCircle2, CloudUpload, RefreshCw, Trash2, WifiOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConexion } from "@/hooks/use-conexion";

const dinero = (valor: number) => `$${valor.toFixed(2)}`;
const plural = (n: number, palabra: string) => `${n} ${palabra}${n === 1 ? "" : "s"}`;

const FRANJA = "flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs sm:px-6";
const AMBAR = "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";

// Franjas bajo la barra superior: sin conexión, ventas por subir, ventas con error y resultado de
// la última subida. Solo aparecen con la base en la nube.
export function AvisoConexion() {
  const { sinConexion, pendientes, subiendo, avisoSubida, cerrarAvisoSubida } = useConexion();
  const [listaAbierta, setListaAbierta] = useState(false);

  const conError = pendientes.filter((p) => p.error).length;
  const porSubir = pendientes.length - conError;
  const verLista = (
    <button type="button" className="ml-auto shrink-0 font-medium underline underline-offset-2" onClick={() => setListaAbierta(true)}>
      Ver
    </button>
  );

  return (
    <>
      {sinConexion && (
        <div role="status" className={`${FRANJA} ${AMBAR}`}>
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-medium">Sin conexión.</span> Puedes consultar y vender: las ventas se guardan en
            este equipo y se suben solas al volver internet. Lo demás no se puede modificar hasta entonces.
            {pendientes.length > 0 && <span className="font-medium"> {plural(pendientes.length, "venta")} por subir.</span>}
          </span>
          {pendientes.length > 0 && verLista}
        </div>
      )}

      {!sinConexion && subiendo && (
        <div role="status" className={`${FRANJA} bg-muted/60 text-muted-foreground`}>
          <CloudUpload className="h-3.5 w-3.5 shrink-0 animate-pulse" />
          Subiendo {plural(porSubir, "venta")} hechas sin conexión...
        </div>
      )}

      {!sinConexion && !subiendo && conError > 0 && (
        <div role="alert" className={`${FRANJA} border-destructive/40 bg-destructive/10 text-destructive`}>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            {conError === 1 ? "Una venta hecha sin conexión no se pudo subir." : `${conError} ventas hechas sin conexión no se pudieron subir.`}
          </span>
          {verLista}
        </div>
      )}

      {avisoSubida && (
        <div
          role="status"
          className={`${FRANJA} ${
            avisoSubida.stockNegativo.length > 0
              ? AMBAR
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          }`}
        >
          {avisoSubida.stockNegativo.length > 0 ? (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0">
            Se {avisoSubida.subidas === 1 ? "subió" : "subieron"} {plural(avisoSubida.subidas, "venta")} hechas sin conexión.
            {avisoSubida.stockNegativo.length > 0 && (
              <>
                {" "}Se vendió más de lo que había en stock, revisa el inventario:{" "}
                <span className="font-medium">{avisoSubida.stockNegativo.join(", ")}</span>.
              </>
            )}
          </span>
          <button type="button" className="ml-auto shrink-0 rounded p-0.5 hover:bg-foreground/10" onClick={cerrarAvisoSubida} aria-label="Cerrar aviso">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <VentasPendientesDialog open={listaAbierta} onOpenChange={setListaAbierta} />
    </>
  );
}

function VentasPendientesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { sinConexion, pendientes, subiendo, subirPendientes, descartarPendiente } = useConexion();
  const [porDescartar, setPorDescartar] = useState<string | null>(null);
  const [error, setError] = useState("");

  const descartar = async (codigo: string) => {
    setError("");
    try {
      await descartarPendiente(codigo);
    } catch (err) {
      setError(typeof err === "string" ? err : "No se pudo descartar la venta.");
    } finally {
      setPorDescartar(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ventas hechas sin conexión</DialogTitle>
          <DialogDescription>
            Están guardadas en este equipo y se suben solas cuando hay internet. Las marcadas en rojo no se
            pudieron subir: revisa el motivo y reinténtalo, o descártala si ya no corresponde.
          </DialogDescription>
        </DialogHeader>

        {pendientes.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No hay ventas por subir.</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
            {pendientes.map((p) => (
              <li key={p.codigo} className="space-y-1 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium tabular-nums">{p.fecha}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.clienteNombre || "Consumidor final"} · {p.unidades} {p.unidades === 1 ? "unidad" : "unidades"}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{dinero(p.total)}</span>
                </div>
                {p.error && (
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs text-destructive">{p.error}</p>
                    {porDescartar === p.codigo ? (
                      <div className="flex shrink-0 gap-1">
                        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setPorDescartar(null)}>
                          No
                        </Button>
                        <Button type="button" variant="destructive" size="sm" className="h-7" onClick={() => descartar(p.codigo)}>
                          Descartar venta
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setPorDescartar(p.codigo)}
                        aria-label={`Descartar venta del ${p.fecha}`}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter className="-mx-0 -mb-0 border-t-0 bg-transparent p-0 pt-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
          <Button type="button" onClick={subirPendientes} disabled={sinConexion || subiendo || pendientes.length === 0}>
            <RefreshCw className={`h-4 w-4 ${subiendo ? "animate-spin" : ""}`} />
            {subiendo ? "Subiendo..." : "Reintentar ahora"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
