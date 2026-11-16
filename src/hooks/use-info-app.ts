import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

// Datos fijos de la app. El nombre y la versión salen de src-tauri/tauri.conf.json
// (productName / version); el creador debe coincidir con "publisher" de ese archivo.
export const NOMBRE_APP = "Total Stock";
export const CREADOR_APP = "Castro Jean Pierre";

// Versión instalada, leída de Tauri (así nunca queda desactualizada respecto al instalador).
export function useVersionApp() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((err) => console.error("No se pudo leer la versión de la app:", err));
  }, []);
  return version;
}
