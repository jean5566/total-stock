import { Skeleton } from "@/components/ui/skeleton";

// Marcador de carga con la forma aproximada de una tabla, para que la vista no "salte" de un
// mensaje vacío a la tabla cuando llegan los datos.
export function TablaSkeleton({ filas = 6 }: { filas?: number }) {
  return (
    <div className="border rounded-md p-3 space-y-3" aria-busy="true" aria-label="Cargando">
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: filas }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
