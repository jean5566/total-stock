import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Debe coincidir con el struct Ajustes en src-tauri/src/lib.rs
export interface Ajustes {
  usarMedida: boolean;
  usarAplicacion: boolean;
}

// Claves con las que se guarda cada ajuste (AJUSTES_BOOLEANOS en src-tauri/src/lib.rs)
export const CLAVES_AJUSTES: Record<keyof Ajustes, string> = {
  usarMedida: "usar_medida",
  usarAplicacion: "usar_aplicacion",
};

const AJUSTES_POR_DEFECTO: Ajustes = { usarMedida: false, usarAplicacion: false };

// Lee los ajustes guardados en la base de datos. `cargado` permite esperar antes de mostrar
// columnas que dependen del ajuste (evita que aparezcan y desaparezcan de golpe).
export function useAjustes() {
  const [ajustes, setAjustes] = useState<Ajustes>(AJUSTES_POR_DEFECTO);
  const [cargado, setCargado] = useState(false);

  useEffect(() => {
    invoke<Ajustes>("obtener_ajustes")
      .then(setAjustes)
      .catch((err) => console.error("Error al cargar ajustes:", err))
      .finally(() => setCargado(true));
  }, []);

  return { ajustes, setAjustes, cargado };
}

// Texto del buscador según los campos activos (código, detalle, medida, aplicación).
export function placeholderBusqueda(ajustes: Ajustes): string {
  const campos = ["código", "detalle"];
  if (ajustes.usarMedida) campos.push("medida");
  if (ajustes.usarAplicacion) campos.push("aplicación");
  const ultimo = campos.pop();
  return `Buscar por ${campos.join(", ")} o ${ultimo}...`;
}
