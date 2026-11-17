import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Con la base en la nube, leer funciona sin internet (copia local) pero guardar no: los cambios se
// envían a Turso. Este contexto avisa a toda la app cuándo no hay conexión, para desactivar los
// botones de guardar en vez de dejar que fallen. Las ventas son la excepción: sin internet se
// guardan en este equipo (ventas pendientes) y se suben solas cuando vuelve la conexión.

// Cada cuánto se comprueba la conexión. Sin conexión se mira más seguido para reactivar los
// botones (y subir las ventas pendientes) apenas vuelva internet.
const INTERVALO_EN_LINEA_MS = 20_000;
const INTERVALO_SIN_CONEXION_MS = 5_000;

export const MENSAJE_SIN_CONEXION = "Sin conexión a internet: no se pueden guardar cambios.";

// Debe coincidir con VentaPendiente en src-tauri/src/lib.rs (solo los campos que usa la pantalla)
export interface VentaPendiente {
  codigo: string;
  fecha: string;
  total: number;
  cambio: number;
  unidades: number;
  clienteNombre: string;
  // Motivo por el que no se pudo subir; null = espera a que haya conexión
  error: string | null;
}

interface ResultadoSubida {
  subidas: number;
  stockNegativo: string[];
  pendientes: VentaPendiente[];
}

// Mensaje después de subir ventas pendientes (se muestra hasta que el usuario lo cierra)
export interface AvisoSubida {
  subidas: number;
  stockNegativo: string[];
}

interface EstadoConexion {
  // true solo si la base está en la nube y Turso no responde. Con base local siempre es false.
  sinConexion: boolean;
  // Vuelve a comprobar ya (p. ej. después de que un guardado falló por la red).
  comprobar: () => void;
  pendientes: VentaPendiente[];
  subiendo: boolean;
  avisoSubida: AvisoSubida | null;
  cerrarAvisoSubida: () => void;
  // Vuelve a leer la lista (después de registrar una venta sin conexión).
  refrescarPendientes: () => void;
  subirPendientes: () => void;
  descartarPendiente: (codigo: string) => Promise<void>;
  // Aumenta cada vez que se suben ventas: las vistas pueden recargar sus datos.
  versionDatos: number;
}

const ConexionContext = createContext<EstadoConexion>({
  sinConexion: false,
  comprobar: () => {},
  pendientes: [],
  subiendo: false,
  avisoSubida: null,
  cerrarAvisoSubida: () => {},
  refrescarPendientes: () => {},
  subirPendientes: () => {},
  descartarPendiente: async () => {},
  versionDatos: 0,
});

export function ConexionProvider({ enNube, children }: { enNube: boolean; children: ReactNode }) {
  const [enLinea, setEnLinea] = useState(true);
  const [pendientes, setPendientes] = useState<VentaPendiente[]>([]);
  const [subiendo, setSubiendo] = useState(false);
  const [avisoSubida, setAvisoSubida] = useState<AvisoSubida | null>(null);
  const [versionDatos, setVersionDatos] = useState(0);
  // Descarta respuestas viejas: si llegan dos comprobaciones desordenadas, vale la última.
  const ultimaComprobacion = useRef(0);
  // Refs para usar el valor actual dentro de callbacks sin recrearlos
  const pendientesRef = useRef<VentaPendiente[]>([]);
  const subiendoRef = useRef(false);

  const actualizarPendientes = useCallback((lista: VentaPendiente[]) => {
    pendientesRef.current = lista;
    setPendientes(lista);
  }, []);

  const refrescarPendientes = useCallback(() => {
    if (!enNube) return;
    invoke<VentaPendiente[]>("obtener_ventas_pendientes")
      .then(actualizarPendientes)
      .catch((err) => console.error("Error al leer las ventas pendientes:", err));
  }, [enNube, actualizarPendientes]);

  const subirPendientes = useCallback(() => {
    if (!enNube || subiendoRef.current || pendientesRef.current.length === 0) return;
    subiendoRef.current = true;
    setSubiendo(true);
    invoke<ResultadoSubida>("subir_ventas_pendientes")
      .then((r) => {
        actualizarPendientes(r.pendientes);
        if (r.subidas > 0) {
          setAvisoSubida({ subidas: r.subidas, stockNegativo: r.stockNegativo });
          setVersionDatos((v) => v + 1);
        }
      })
      .catch((err) => {
        // Casi siempre es que se volvió a cortar internet: se reintenta en la próxima comprobación
        console.error("Error al subir las ventas pendientes:", err);
        refrescarPendientes();
      })
      .finally(() => {
        subiendoRef.current = false;
        setSubiendo(false);
      });
  }, [enNube, actualizarPendientes, refrescarPendientes]);

  const comprobar = useCallback(() => {
    if (!enNube) return;
    const id = ++ultimaComprobacion.current;
    invoke<boolean>("comprobar_conexion_nube")
      .catch(() => false)
      .then((ok) => {
        if (id !== ultimaComprobacion.current) return;
        setEnLinea(ok);
        // Con conexión se suben las ventas que esperan (las que fallaron por otro motivo se
        // reintentan a mano desde la lista, para no repetir el mismo error cada pocos segundos)
        if (ok && pendientesRef.current.some((p) => !p.error)) subirPendientes();
      });
  }, [enNube, subirPendientes]);

  const descartarPendiente = useCallback(async (codigo: string) => {
    actualizarPendientes(await invoke<VentaPendiente[]>("descartar_venta_pendiente", { codigo }));
  }, [actualizarPendientes]);

  // Comprobación inicial y avisos del sistema (más rápidos que esperar al siguiente intervalo)
  useEffect(() => {
    if (!enNube) {
      ultimaComprobacion.current++;
      setEnLinea(true);
      actualizarPendientes([]);
      return;
    }
    // Primero la lista, así la comprobación ya sabe si hay ventas por subir
    invoke<VentaPendiente[]>("obtener_ventas_pendientes")
      .then(actualizarPendientes)
      .catch((err) => console.error("Error al leer las ventas pendientes:", err))
      .finally(comprobar);
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
  }, [enNube, comprobar, actualizarPendientes]);

  useEffect(() => {
    if (!enNube) return;
    const intervalo = setInterval(comprobar, enLinea ? INTERVALO_EN_LINEA_MS : INTERVALO_SIN_CONEXION_MS);
    return () => clearInterval(intervalo);
  }, [enNube, enLinea, comprobar]);

  return (
    <ConexionContext.Provider
      value={{
        sinConexion: enNube && !enLinea,
        comprobar,
        pendientes,
        subiendo,
        avisoSubida,
        cerrarAvisoSubida: () => setAvisoSubida(null),
        refrescarPendientes,
        subirPendientes,
        descartarPendiente,
        versionDatos,
      }}
    >
      {children}
    </ConexionContext.Provider>
  );
}

export function useConexion() {
  return useContext(ConexionContext);
}
