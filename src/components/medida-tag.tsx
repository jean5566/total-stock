import { Puzzle } from "lucide-react";

// Etiqueta pequeña para mostrar la medida de un producto junto a su detalle.
export function MedidaTag({ medida }: { medida: string }) {
  return (
    <span className="ml-2 inline-block rounded border px-1.5 py-px align-middle font-mono font-normal text-muted-foreground">
      {medida}
    </span>
  );
}

// Línea secundaria con la aplicación del producto (para qué sirve o con qué es compatible), debajo del detalle.
export function AplicacionTexto({ aplicacion }: { aplicacion: string }) {
  return (
    <div className="mt-0.5 flex items-start gap-1 text-[11px] font-normal text-muted-foreground">
      <Puzzle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="line-clamp-2" title={aplicacion}>
        {aplicacion}
      </span>
    </div>
  );
}
