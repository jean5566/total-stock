import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WifiOff } from "lucide-react";

// Con la base en la nube, leer funciona sin internet (copia local) pero guardar no: los cambios se
// envían a Turso. Este contexto avisa a toda la app cuándo no hay conexión para desactivar los
// botones de guardar en vez de dejar que fallen.

// Cada cuánto se comprueba la conexión. Sin conexión se mira más seguido para reactivar los
// botones apenas vuelva internet.
const INTERVALO_EN_LINEA_MS = 20_000;
const INTERVALO_SIN_CONEXION_MS = 5_000;

export const MENSAJE_SIN_CONEXION = "Sin conexión a internet: no se pueden guardar cambios.";

interface EstadoConexion {
  // true solo si la base está en la nube y Turso no responde. Con base local siempre es false.
  sinConexion: boolean;
  // Vuelve a comprobar ya (p. ej. después de que un guardado falló por la red).
  comprobar: () => void;
}

const ConexionContext = createContext<EstadoConexion>({ sinConexion: false, comprobar: () => {} });

export function ConexionProvider({ enNube, children }: { enNube: boolean; children: ReactNode }) {
  const [enLinea, setEnLinea] = useState(true);
  // Descarta respuestas viejas: si llegan dos comprobaciones desordenadas, vale la última.
  const ultimaComprobacion = useRef(0);

  const comprobar = useCallback(() => {
    if (!enNube) return;
    const id = ++ultimaComprobacion.current;
    invoke<boolean>("comprobar_conexion_nube")
      .catch(() => false)
      .then((ok) => {
        if (id === ultimaComprobacion.current) setEnLinea(ok);
      });
  }, [enNube]);

  // Comprobación inicial y avisos del sistema (más rápidos que esperar al siguiente intervalo)
  useEffect(() => {
    if (!enNube) {
      ultimaComprobacion.current++;
      setEnLinea(true);
      return;
    }
    comprobar();
    const alDesconectar = () => {
      ultimaComprobacion.current++;
      setEnLinea(false);
    };
    window.addEventListener("online", comprobar);
    window.addEventListener("offline", alDesconectar);
    return () => {
      window.removeEventListener("online", comprobar);
      window.removeEventListener("offline", alDesconectar);
    };
  }, [enNube, comprobar]);

  useEffect(() => {
    if (!enNube) return;
    const intervalo = setInterval(comprobar, enLinea ? INTERVALO_EN_LINEA_MS : INTERVALO_SIN_CONEXION_MS);
    return () => clearInterval(intervalo);
  }, [enNube, enLinea, comprobar]);

  return (
    <ConexionContext.Provider value={{ sinConexion: enNube && !enLinea, comprobar }}>
      {children}
    </ConexionContext.Provider>
  );
}

export function useConexion() {
  return useContext(ConexionContext);
}

// Franja de aviso bajo la barra superior mientras no hay conexión.
export function AvisoSinConexion() {
  const { sinConexion } = useConexion();
  if (!sinConexion) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 sm:px-6 dark:text-amber-400"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>
        <span className="font-medium">Sin conexión.</span> Puedes consultar tus datos, pero no guardar cambios
        hasta que vuelva internet.
      </span>
    </div>
  );
}
