import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Cloud } from "lucide-react";
import { FormConectarNube } from "@/components/nube-card";

export interface InfoBaseDatos {
  nombre: string;
  ruta: string;
  totalProductos: number;
  // true si los datos están en Turso y se comparten con otros dispositivos
  enNube: boolean;
}

interface ConfigurarBaseDatosViewProps {
  onCreada: (info: InfoBaseDatos) => void;
}

// Nombres reservados por Windows (NOMBRES_RESERVADOS_WINDOWS en src-tauri/src/lib.rs)
const RESERVADO_WINDOWS = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

// Misma limpieza que sanear_nombre_archivo en src-tauri/src/lib.rs: solo letras, números, espacios,
// '-' y '_'; sin espacios en los extremos ni repetidos; máximo 60 caracteres; "_" al final si el
// nombre está reservado por Windows.
function limpiarNombre(nombre: string) {
  const limpio = [...nombre.replace(/[^\p{L}\p{N}\-_ ]/gu, "").split(/\s+/).filter(Boolean).join(" ")]
    .slice(0, 60)
    .join("")
    .trim();
  return RESERVADO_WINDOWS.test(limpio) ? `${limpio}_` : limpio;
}

export function ConfigurarBaseDatosView({ onCreada }: ConfigurarBaseDatosViewProps) {
  const [nombre, setNombre] = useState("");
  const [error, setError] = useState("");
  const [creando, setCreando] = useState(false);
  // true = en vez de crear una base nueva, conectarse a la que ya está en la nube
  const [modoNube, setModoNube] = useState(false);

  const nombreFinal = limpiarNombre(nombre);

  const manejarCrear = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nombreFinal) {
      setError("Ingresa un nombre para la base de datos (letras o números).");
      return;
    }

    setCreando(true);
    try {
      const info: InfoBaseDatos = await invoke("crear_base_de_datos", { nombre: nombreFinal });
      onCreada(info);
    } catch (err) {
      console.error("Error al crear la base de datos:", err);
      setError(typeof err === "string" ? err : "No se pudo crear la base de datos.");
    } finally {
      setCreando(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-10 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center gap-2 pt-2 text-center">
          <img src="/logo.svg" alt="Total Stock" className="mx-auto mb-1 h-14 w-14" draggable={false} />
          <CardTitle className="text-lg">
            {modoNube ? "Conectar a la nube" : "Configura tu Base de Datos"}
          </CardTitle>
          <CardDescription className="mx-auto max-w-xs">
            {modoNube
              ? "Pega la URL y el token de tu base en Turso para usar los mismos datos que en tus otros dispositivos."
              : "Es la primera vez que abres la app. Ponle un nombre a tu base de datos para empezar."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pb-2">
          {modoNube ? (
            <FormConectarNube textoBoton="Conectar" onConectada={onCreada} />
          ) : (
          <form onSubmit={manejarCrear} className="space-y-5" noValidate autoComplete="off">
            <div className="space-y-2">
              <Label htmlFor="nombre-db">Nombre de la base de datos</Label>
              <Input
                id="nombre-db"
                placeholder="Ej. Mi Negocio"
                value={nombre}
                maxLength={80}
                onChange={(e) => {
                  setNombre(e.target.value);
                  setError("");
                }}
                aria-invalid={Boolean(error)}
                aria-describedby="nombre-db-ayuda"
                autoFocus
              />
              {error ? (
                <p className="text-xs text-destructive">{error}</p>
              ) : (
                <p id="nombre-db-ayuda" className="text-xs text-muted-foreground">
                  {nombreFinal ? (
                    <>
                      Se guardará como <span className="font-mono text-foreground">{nombreFinal}.db</span>
                    </>
                  ) : (
                    "Puedes usar letras, números, espacios, guiones y guion bajo."
                  )}
                </p>
              )}
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={creando}>
              {creando ? "Creando..." : "Crear Base de Datos"}
            </Button>
          </form>
          )}
          <Button type="button" variant="ghost" className="w-full text-xs" onClick={() => setModoNube((v) => !v)}>
            {modoNube ? (
              "Mejor crear una base nueva en este dispositivo"
            ) : (
              <>
                <Cloud className="h-4 w-4" />
                ¿Ya tienes tus datos en la nube? Conéctate
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
