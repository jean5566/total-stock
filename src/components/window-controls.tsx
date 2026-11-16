import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { guardarVentasAbiertasAhora } from "@/hooks/use-ventas-abiertas";

// Botones de minimizar / maximizar / cerrar propios. La ventana no tiene la barra de título de
// Windows ("decorations": false en tauri.conf.json), así que estos botones la reemplazan.
export function WindowControls({ className }: { className?: string }) {
  const [maximizada, setMaximizada] = useState(false);

  useEffect(() => {
    const ventana = getCurrentWindow();
    let quitarEscucha: (() => void) | undefined;
    let activo = true;

    const actualizar = () => {
      ventana.isMaximized().then((v) => activo && setMaximizada(v)).catch(() => {});
    };
    actualizar();
    ventana
      .onResized(actualizar)
      .then((quitar) => {
        if (activo) quitarEscucha = quitar;
        else quitar();
      })
      .catch(() => {});

    return () => {
      activo = false;
      quitarEscucha?.();
    };
  }, []);

  const ventana = () => getCurrentWindow();
  const boton =
    "inline-flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none";

  return (
    <div className={cn("flex h-full shrink-0 items-stretch", className)}>
      <button
        type="button"
        aria-label="Minimizar"
        title="Minimizar"
        className={boton}
        onClick={() => ventana().minimize()}
      >
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        aria-label={maximizada ? "Restaurar" : "Maximizar"}
        title={maximizada ? "Restaurar" : "Maximizar"}
        className={boton}
        onClick={() => ventana().toggleMaximize()}
      >
        {maximizada ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label="Cerrar"
        title="Cerrar"
        className={cn(boton, "hover:bg-red-600 hover:text-white")}
        // Antes de cerrar se guarda lo pendiente de las ventas abiertas (se guardan con un retraso)
        onClick={() => guardarVentasAbiertasAhora().finally(() => ventana().close())}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

// Barra de título propia: se arrastra para mover la ventana y con doble clic se maximiza.
export function TitleBar({ className }: { className?: string }) {
  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex h-9 shrink-0 items-center justify-between border-b bg-titlebar pl-3 select-none",
        className
      )}
    >
      <div data-tauri-drag-region className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <img src="/logo.svg" alt="" className="pointer-events-none size-4" draggable={false} />
        <span data-tauri-drag-region>Total Stock</span>
      </div>
      <WindowControls />
    </div>
  );
}
