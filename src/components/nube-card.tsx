import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cloud, CloudOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { InfoBaseDatos } from "@/views/configurar-base-datos";
import { MENSAJE_SIN_CONEXION, useConexion } from "@/hooks/use-conexion";

function mensajeError(err: unknown, porDefecto: string) {
  return typeof err === "string" ? err : porDefecto;
}

// Formulario para conectar este dispositivo a una base de Turso (URL + token).
// Se usa en la pantalla de primer inicio y en Configuración.
export function FormConectarNube({
  textoBoton,
  onConectada,
}: {
  textoBoton: string;
  onConectada: (info: InfoBaseDatos) => void;
}) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [conectando, setConectando] = useState(false);

  const conectar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !token.trim()) {
      setError("Pega la URL y el token de tu base en Turso.");
      return;
    }
    setConectando(true);
    setError("");
    try {
      const info: InfoBaseDatos = await invoke("conectar_nube", { url, token });
      onConectada(info);
    } catch (err) {
      console.error("Error al conectar con la nube:", err);
      setError(mensajeError(err, "No se pudo conectar con la nube."));
    } finally {
      setConectando(false);
    }
  };

  return (
    <form onSubmit={conectar} className="space-y-4" noValidate autoComplete="off">
      <div className="space-y-2">
        <Label htmlFor="nube-url">URL de la base</Label>
        <Input
          id="nube-url"
          placeholder="libsql://mi-base-usuario.turso.io"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError("");
          }}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono text-xs"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="nube-token">Token</Label>
        <Input
          id="nube-token"
          type="password"
          placeholder="eyJhbGciOi..."
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setError("");
          }}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono text-xs"
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={conectando}>
        {conectando ? "Conectando... (puede tardar un poco)" : textoBoton}
      </Button>
    </form>
  );
}

// Tarjeta de Configuración: conectar a la nube o, si ya está conectada, sincronizar a mano.
export function NubeCard({
  info,
  onCambio,
}: {
  info: InfoBaseDatos | null;
  onCambio: (info: InfoBaseDatos) => void;
}) {
  const { sinConexion } = useConexion();
  const [sincronizando, setSincronizando] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");

  const sincronizar = async () => {
    setSincronizando(true);
    setMensaje("");
    setError("");
    try {
      const nueva: InfoBaseDatos = await invoke("sincronizar_nube");
      onCambio(nueva);
      setMensaje("Datos al día.");
    } catch (err) {
      console.error("Error al sincronizar:", err);
      setError(mensajeError(err, "No se pudo sincronizar."));
    } finally {
      setSincronizando(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {info?.enNube ? <Cloud className="h-4 w-4" /> : <CloudOff className="h-4 w-4" />}
          Nube (laptop y teléfono)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {info?.enNube ? (
          <>
            <p className="text-sm text-muted-foreground">
              Conectada. Los cambios de los otros dispositivos llegan solos cada pocos segundos. Sin
              internet puedes consultar, pero vender o editar necesita conexión.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={sincronizar}
              disabled={sincronizando || sinConexion}
              title={sinConexion ? MENSAJE_SIN_CONEXION : undefined}
            >
              <RefreshCw className={`h-4 w-4 ${sincronizando ? "animate-spin" : ""}`} />
              {sincronizando ? "Sincronizando..." : "Sincronizar ahora"}
            </Button>
            {mensaje && <p className="text-xs text-muted-foreground">{mensaje}</p>}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Sube tus datos a Turso para ver y usar la misma información en otros dispositivos. Antes
              se guarda una copia de seguridad de esta base.
            </p>
            <FormConectarNube textoBoton="Conectar y subir mis datos" onConectada={onCambio} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
