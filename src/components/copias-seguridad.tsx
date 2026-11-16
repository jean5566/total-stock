import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArchiveRestore, FolderOpen, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { InfoBaseDatos } from "@/views/configurar-base-datos";

// Debe coincidir con el struct CopiaSeguridad en src-tauri/src/lib.rs
interface CopiaSeguridad {
  archivo: string;
  fecha: string;
  automatica: boolean;
  tamanoBytes: number;
}

const BOTON_ROJO = "bg-destructive text-white hover:bg-destructive/90";

function formatearTamano(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mensajeError(err: unknown, porDefecto: string): string {
  return typeof err === "string" ? err : porDefecto;
}

interface CopiasSeguridadCardProps {
  // Se llama después de restaurar una copia, con la información de la base ya restaurada
  onRestaurada: (info: InfoBaseDatos) => void;
}

export function CopiasSeguridadCard({ onRestaurada }: CopiasSeguridadCardProps) {
  const [copias, setCopias] = useState<CopiaSeguridad[]>([]);
  const [ocupado, setOcupado] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");

  // Copia pendiente de confirmación (restaurar o eliminar)
  const [aRestaurar, setARestaurar] = useState<CopiaSeguridad | null>(null);
  const [aEliminar, setAEliminar] = useState<CopiaSeguridad | null>(null);

  useEffect(() => {
    invoke<CopiaSeguridad[]>("obtener_copias_seguridad")
      .then(setCopias)
      .catch((err) => console.error("Error al cargar copias de seguridad:", err));
  }, []);

  // Ejecuta una acción mostrando el estado "ocupado" y el mensaje de resultado.
  const ejecutar = async (accion: () => Promise<void>, errorPorDefecto: string) => {
    setOcupado(true);
    setMensaje("");
    setError("");
    try {
      await accion();
    } catch (err) {
      console.error(errorPorDefecto, err);
      setError(mensajeError(err, errorPorDefecto));
    } finally {
      setOcupado(false);
    }
  };

  const crearCopia = () =>
    ejecutar(async () => {
      setCopias(await invoke<CopiaSeguridad[]>("crear_copia_seguridad"));
      setMensaje("Copia creada.");
    }, "No se pudo crear la copia.");

  const abrirCarpeta = () =>
    ejecutar(() => invoke("abrir_carpeta_copias"), "No se pudo abrir la carpeta.");

  const restaurar = (copia: CopiaSeguridad) =>
    ejecutar(async () => {
      const info = await invoke<InfoBaseDatos>("restaurar_copia_seguridad", { archivo: copia.archivo });
      // La restauración guarda antes una copia automática del estado anterior
      setCopias(await invoke<CopiaSeguridad[]>("obtener_copias_seguridad"));
      setMensaje(`Copia del ${copia.fecha} restaurada.`);
      onRestaurada(info);
    }, "No se pudo restaurar la copia.");

  const eliminar = (copia: CopiaSeguridad) =>
    ejecutar(async () => {
      setCopias(await invoke<CopiaSeguridad[]>("eliminar_copia_seguridad", { archivo: copia.archivo }));
    }, "No se pudo eliminar la copia.");

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ArchiveRestore className="h-4 w-4" />
          Copias de seguridad
        </CardTitle>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={abrirCarpeta} disabled={ocupado}>
            <FolderOpen className="h-4 w-4" />
            Carpeta
          </Button>
          <Button type="button" size="sm" onClick={crearCopia} disabled={ocupado}>
            <Plus className="h-4 w-4" />
            Crear copia
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {mensaje && <p className="text-xs text-emerald-600 dark:text-emerald-400">{mensaje}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}

        {copias.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin copias todavía.</p>
        ) : (
          <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
            {copias.map((copia) => (
              <li key={copia.archivo} className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium tabular-nums">{copia.fecha}</p>
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    {formatearTamano(copia.tamanoBytes)}
                    {copia.automatica && (
                      <Badge variant="outline" className="text-[10px]">Automática</Badge>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setARestaurar(copia)}
                    disabled={ocupado}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restaurar
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setAEliminar(copia)}
                    disabled={ocupado}
                    aria-label={`Eliminar copia del ${copia.fecha}`}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Confirmar restauración */}
      <AlertDialog open={aRestaurar !== null} onOpenChange={(open) => !open && setARestaurar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Restaurar esta copia?</AlertDialogTitle>
            <AlertDialogDescription>
              Los datos volverán al {aRestaurar?.fecha}. Antes se guarda una copia automática de los datos actuales.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (aRestaurar) restaurar(aRestaurar);
                setARestaurar(null);
              }}
            >
              Restaurar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmar eliminación */}
      <AlertDialog open={aEliminar !== null} onOpenChange={(open) => !open && setAEliminar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar esta copia?</AlertDialogTitle>
            <AlertDialogDescription>Copia del {aEliminar?.fecha}. No se puede deshacer.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className={BOTON_ROJO}
              onClick={() => {
                if (aEliminar) eliminar(aEliminar);
                setAEliminar(null);
              }}
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
