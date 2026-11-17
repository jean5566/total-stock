import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Plus, Search, UserRound } from "lucide-react";
import { aMayusculas } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ClienteFormDialog, etiquetaTipoIdentificacion, type Cliente } from "@/components/cliente-form";
import { MENSAJE_SIN_CONEXION, useConexion } from "@/hooks/use-conexion";

interface SelectorClienteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seleccionado: Cliente | null;
  // null = consumidor final
  onElegir: (cliente: Cliente | null) => void;
}

// Diálogo para elegir el cliente de una venta: búsqueda por identificación / nombre / teléfono,
// opción "Consumidor final" y alta rápida de un cliente nuevo.
export function SelectorClienteDialog({ open, onOpenChange, seleccionado, onElegir }: SelectorClienteDialogProps) {
  const { sinConexion } = useConexion();
  const [busqueda, setBusqueda] = useState("");
  const [resultados, setResultados] = useState<Cliente[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [formAbierto, setFormAbierto] = useState(false);

  useEffect(() => {
    if (open) {
      setBusqueda("");
      setResultados([]);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const texto = busqueda.trim();
    if (!texto) {
      setResultados([]);
      return;
    }
    const t = setTimeout(async () => {
      setBuscando(true);
      try {
        const lista: Cliente[] = await invoke("buscar_clientes", { busqueda: texto });
        setResultados(lista);
      } catch (err) {
        console.error("Error al buscar clientes:", err);
      } finally {
        setBuscando(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [busqueda, open]);

  const elegir = (cliente: Cliente | null) => {
    onElegir(cliente);
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cliente de la venta</DialogTitle>
            <DialogDescription>Busca un cliente o deja la venta a consumidor final.</DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              placeholder="Cédula, RUC, nombre o teléfono..."
              value={busqueda}
              onChange={(e) => setBusqueda(aMayusculas(e))}
              onKeyDown={(e) => {
                // Enter elige la coincidencia exacta de identificación (o el único resultado)
                if (e.key === "Enter") {
                  e.preventDefault();
                  // Enter que confirma una composición IME (chino, japonés, coreano) no debe elegir
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  const texto = busqueda.trim();
                  const exacto =
                    resultados.find((c) => c.identificacion === texto) ?? (resultados.length === 1 ? resultados[0] : null);
                  if (exacto) elegir(exacto);
                }
              }}
              className="pl-8 uppercase"
            />
          </div>

          <div className="max-h-72 space-y-1 overflow-y-auto">
            <OpcionCliente
              titulo="CONSUMIDOR FINAL"
              subtitulo="Venta sin datos del cliente"
              activo={seleccionado === null}
              onClick={() => elegir(null)}
            />
            {resultados.map((c) => (
              <OpcionCliente
                key={c.id}
                titulo={c.nombre}
                subtitulo={`${etiquetaTipoIdentificacion(c.tipoIdentificacion)} ${c.identificacion}${
                  c.telefono ? ` · ${c.telefono}` : ""
                }`}
                activo={seleccionado?.id === c.id}
                onClick={() => elegir(c)}
              />
            ))}
            {busqueda.trim() && !buscando && resultados.length === 0 && (
              <p className="py-3 text-center text-xs text-muted-foreground">No se encontró ningún cliente.</p>
            )}
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={() => setFormAbierto(true)}
            disabled={sinConexion}
            title={sinConexion ? MENSAJE_SIN_CONEXION : undefined}
          >
            <Plus className="h-4 w-4" />
            Nuevo cliente{busqueda.trim() ? ` "${busqueda.trim()}"` : ""}
          </Button>
        </DialogContent>
      </Dialog>

      <ClienteFormDialog
        open={formAbierto}
        onOpenChange={setFormAbierto}
        cliente={null}
        sugerencia={busqueda}
        onGuardado={(nuevo) => elegir(nuevo)}
      />
    </>
  );
}

function OpcionCliente({
  titulo,
  subtitulo,
  activo,
  onClick,
}: {
  titulo: string;
  subtitulo: string;
  activo: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted ${
        activo ? "border-primary bg-muted" : "border-transparent"
      }`}
    >
      <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium uppercase">{titulo}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">{subtitulo}</span>
      </span>
      {activo && <Check className="h-4 w-4 shrink-0" aria-label="Seleccionado" />}
    </button>
  );
}
