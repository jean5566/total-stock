import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, ChevronDown, Database, Info, Package, Trash2 } from "lucide-react";
import { CREADOR_APP, NOMBRE_APP, useVersionApp } from "@/hooks/use-info-app";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CLAVES_AJUSTES, useAjustes, type Ajustes } from "@/hooks/use-ajustes";
import type { InfoBaseDatos } from "@/views/configurar-base-datos";
import { CopiasSeguridadCard } from "@/components/copias-seguridad";
import { DatosNegocioCard } from "@/components/datos-negocio";

interface ConfiguracionViewProps {
  info: InfoBaseDatos | null;
  // Se llama después de borrar la base, para volver a la pantalla de primer inicio
  onBaseEliminada: () => void;
  // Se llama después de restaurar una copia de seguridad, con la información actualizada
  onBaseRestaurada: (info: InfoBaseDatos) => void;
}

// Debe coincidir con PALABRA_CONFIRMACION en src-tauri/src/lib.rs
const PALABRA_CONFIRMACION = "CONFIRMAR";

// Campos opcionales del catálogo que se pueden activar/desactivar
const CAMPOS_OPCIONALES: { ajuste: keyof Ajustes; titulo: string; detalle: string }[] = [
  {
    ajuste: "usarMedida",
    titulo: "Medida",
    detalle: "Medida, tamaño o presentación de cada producto. Ej.: 500 ML, 1 KG, TALLA M, 20x30 CM. Se puede buscar por medida.",
  },
  {
    ajuste: "usarAplicacion",
    titulo: "Aplicación",
    detalle: "Para qué sirve el producto o con qué es compatible. Ej.: IPHONE 13, 14 o USO EXTERIOR. Se puede buscar por aplicación.",
  },
];

const BOTON_ROJO = "bg-destructive text-white hover:bg-destructive/90";

// Botón "Mostrar más / Mostrar menos" para desplegar los detalles de una tarjeta.
function BotonMostrarMas({ abierto, onClick }: { abierto: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onClick} aria-expanded={abierto} className="text-xs">
      {abierto ? "Mostrar menos" : "Mostrar más"}
      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${abierto ? "rotate-180" : ""}`} />
    </Button>
  );
}

export function ConfiguracionView({ info, onBaseEliminada, onBaseRestaurada }: ConfiguracionViewProps) {
  const { ajustes, setAjustes, cargado } = useAjustes();
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");
  const [verDetalleCatalogo, setVerDetalleCatalogo] = useState(false);
  const [verDetalleBase, setVerDetalleBase] = useState(false);
  // Al restaurar una copia se incrementa para que la tarjeta de datos del negocio se recargue
  const [versionDatos, setVersionDatos] = useState(0);

  // Eliminar base de datos
  const [dialogoEliminarAbierto, setDialogoEliminarAbierto] = useState(false);
  const [confirmacion, setConfirmacion] = useState("");
  const [eliminando, setEliminando] = useState(false);
  const [errorEliminar, setErrorEliminar] = useState("");
  const confirmacionOk = confirmacion === PALABRA_CONFIRMACION;

  const abrirEliminar = () => {
    setConfirmacion("");
    setErrorEliminar("");
    setDialogoEliminarAbierto(true);
  };

  const eliminarBase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmacionOk) return;
    setEliminando(true);
    setErrorEliminar("");
    try {
      await invoke("eliminar_base_de_datos", { confirmacion });
      setDialogoEliminarAbierto(false);
      onBaseEliminada();
    } catch (err) {
      console.error("Error al eliminar la base de datos:", err);
      setErrorEliminar(typeof err === "string" ? err : "No se pudo eliminar la base de datos.");
    } finally {
      setEliminando(false);
    }
  };

  const cambiarAjuste = async (ajuste: keyof Ajustes, activo: boolean) => {
    setGuardando(true);
    setError("");
    try {
      const nuevos: Ajustes = await invoke("guardar_ajuste", { clave: CLAVES_AJUSTES[ajuste], activo });
      setAjustes(nuevos);
    } catch (err) {
      console.error("Error al guardar el ajuste:", err);
      setError(typeof err === "string" ? err : "No se pudo guardar el ajuste.");
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Izquierda: formularios. Derecha: ajustes y acciones (la zona peligrosa queda al final).
          En pantallas angostas las columnas se apilan. */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="space-y-6 min-w-0">
          <DatosNegocioCard key={versionDatos} />
          <AcercaDeCard />
        </div>

        <div className="space-y-6 min-w-0">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Package className="h-4 w-4" />
            Campos del catálogo
          </CardTitle>
          <BotonMostrarMas abierto={verDetalleCatalogo} onClick={() => setVerDetalleCatalogo((v) => !v)} />
        </CardHeader>
        <CardContent className="divide-y">
          {CAMPOS_OPCIONALES.map((campo) => (
            <div key={campo.ajuste} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <label htmlFor={`ajuste-${campo.ajuste}`} className="space-y-0.5">
                <span className="block text-sm font-medium">{campo.titulo}</span>
                {verDetalleCatalogo && (
                  <span className="block text-xs text-muted-foreground">{campo.detalle}</span>
                )}
              </label>
              <Switch
                id={`ajuste-${campo.ajuste}`}
                checked={ajustes[campo.ajuste]}
                disabled={!cargado || guardando}
                onCheckedChange={(activo) => cambiarAjuste(campo.ajuste, activo)}
              />
            </div>
          ))}
          {error && <p className="pt-3 text-xs text-destructive">{error}</p>}
        </CardContent>
      </Card>

      <CopiasSeguridadCard
        onRestaurada={(nuevaInfo) => {
          onBaseRestaurada(nuevaInfo);
          setVersionDatos((v) => v + 1);
          // Los ajustes también vienen de la copia restaurada
          invoke<Ajustes>("obtener_ajustes")
            .then(setAjustes)
            .catch((err) => console.error("Error al recargar ajustes:", err));
        }}
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4" />
            Base de datos
          </CardTitle>
          {info && <BotonMostrarMas abierto={verDetalleBase} onClick={() => setVerDetalleBase((v) => !v)} />}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-muted-foreground">
              {info ? `${info.nombre} · ${info.totalProductos} productos` : "Sin información"}
            </span>
            <Button type="button" size="sm" onClick={abrirEliminar} disabled={!info} className={BOTON_ROJO}>
              <Trash2 className="h-4 w-4" />
              Eliminar
            </Button>
          </div>

          {info && verDetalleBase && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t pt-4 text-sm">
              <dt className="text-muted-foreground">Nombre</dt>
              <dd className="font-medium">{info.nombre}</dd>

              <dt className="text-muted-foreground">Productos guardados</dt>
              <dd className="font-medium">{info.totalProductos}</dd>

              <dt className="text-muted-foreground">Tipo</dt>
              <dd className="font-medium">SQLite</dd>

              <dt className="text-muted-foreground">Archivo</dt>
              <dd className="break-all font-mono text-xs">{info.ruta}</dd>

              <dt className="text-muted-foreground">Eliminar</dt>
              <dd className="text-xs text-muted-foreground">
                Borra productos, inventario, ventas, clientes y ajustes. No se puede deshacer.
              </dd>
            </dl>
          )}
        </CardContent>
      </Card>
        </div>
      </div>

      <Dialog
        open={dialogoEliminarAbierto}
        onOpenChange={(open) => {
          if (!eliminando) setDialogoEliminarAbierto(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              ¿Eliminar la base de datos?
            </DialogTitle>
            <DialogDescription>Se borrará todo. No se puede deshacer.</DialogDescription>
          </DialogHeader>

          <form onSubmit={eliminarBase} className="space-y-4" noValidate autoComplete="off">
            <div className="space-y-1">
              <Label htmlFor="confirmar-eliminar">
                Escribe <span className="font-mono font-bold">{PALABRA_CONFIRMACION}</span>
              </Label>
              <Input
                id="confirmar-eliminar"
                value={confirmacion}
                onChange={(e) => {
                  setConfirmacion(e.target.value);
                  setErrorEliminar("");
                }}
                placeholder={PALABRA_CONFIRMACION}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                className="font-mono"
              />
              {errorEliminar && <p className="text-xs text-destructive">{errorEliminar}</p>}
            </div>

            <DialogFooter className="-mx-0 -mb-0 border-t-0 bg-transparent p-0 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogoEliminarAbierto(false)}
                disabled={eliminando}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={!confirmacionOk || eliminando} className={BOTON_ROJO}>
                {eliminando ? "Eliminando..." : "Eliminar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Información de la app: nombre, versión instalada y creador.
function AcercaDeCard() {
  const version = useVersionApp();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Info className="h-4 w-4" />
          Acerca de
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="" className="h-12 w-12 shrink-0" draggable={false} />
          <div className="min-w-0">
            <p className="font-semibold">{NOMBRE_APP}</p>
            <p className="text-xs text-muted-foreground">Inventario, ventas y clientes</p>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t pt-4 text-sm">
          <dt className="text-muted-foreground">Versión</dt>
          <dd className="font-medium tabular-nums">{version || "—"}</dd>

          <dt className="text-muted-foreground">Creado por</dt>
          <dd className="font-medium">{CREADOR_APP}</dd>

          <dt className="text-muted-foreground">Derechos</dt>
          <dd className="text-muted-foreground">
            © {new Date().getFullYear()} {CREADOR_APP}. Todos los derechos reservados.
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}
