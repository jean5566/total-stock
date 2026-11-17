import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { aMayusculas } from "@/lib/utils";
import { MENSAJE_SIN_CONEXION, useConexion } from "@/hooks/use-conexion";

// Debe coincidir con el struct DatosNegocio en src-tauri/src/lib.rs
export interface DatosNegocio {
  nombreComercial: string;
  razonSocial: string;
  ruc: string;
  direccion: string;
  telefono: string;
  email: string;
}

const VACIO: DatosNegocio = {
  nombreComercial: "",
  razonSocial: "",
  ruc: "",
  direccion: "",
  telefono: "",
  email: "",
};

type Errores = Partial<Record<keyof DatosNegocio | "general", string>>;

function validar(d: DatosNegocio): Errores {
  const errores: Errores = {};
  if (d.nombreComercial.trim().length < 2) errores.nombreComercial = "El nombre del negocio es obligatorio.";
  if (d.ruc.trim() && !/^\d{13}$/.test(d.ruc.trim())) errores.ruc = "El RUC debe tener 13 dígitos.";
  const email = d.email.trim();
  if (email && !(email.includes("@") && email.includes("."))) errores.email = "El email no es válido.";
  return errores;
}

export function DatosNegocioCard() {
  const { sinConexion } = useConexion();
  const [datos, setDatos] = useState<DatosNegocio>(VACIO);
  // Últimos datos guardados, para saber si hay cambios pendientes
  const [guardados, setGuardados] = useState<DatosNegocio>(VACIO);
  const [cargado, setCargado] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [errores, setErrores] = useState<Errores>({});
  const [guardadoOk, setGuardadoOk] = useState(false);

  useEffect(() => {
    invoke<DatosNegocio>("obtener_datos_negocio")
      .then((d) => {
        setDatos(d);
        setGuardados(d);
      })
      .catch((err) => console.error("Error al cargar los datos del negocio:", err))
      .finally(() => setCargado(true));
  }, []);

  const hayCambios = (Object.keys(datos) as (keyof DatosNegocio)[]).some((k) => datos[k] !== guardados[k]);

  const cambiar = (campo: keyof DatosNegocio, valor: string) => {
    if (campo === "ruc") valor = valor.replace(/\D/g, "");
    setDatos((prev) => ({ ...prev, [campo]: valor }));
    setErrores((prev) => ({ ...prev, [campo]: undefined, general: undefined }));
    setGuardadoOk(false);
  };

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sinConexion) return;
    const nuevosErrores = validar(datos);
    setErrores(nuevosErrores);
    if (Object.keys(nuevosErrores).length > 0) return;

    setGuardando(true);
    try {
      const resultado = await invoke<DatosNegocio>("guardar_datos_negocio", { datos });
      setDatos(resultado);
      setGuardados(resultado);
      setGuardadoOk(true);
    } catch (err) {
      console.error("Error al guardar los datos del negocio:", err);
      setErrores({ general: typeof err === "string" ? err : "No se pudieron guardar los datos." });
    } finally {
      setGuardando(false);
    }
  };

  const campo = (
    id: keyof DatosNegocio,
    etiqueta: string,
    props: React.ComponentProps<typeof Input> & { mayusculas?: boolean; opcional?: boolean } = {},
  ) => {
    const { mayusculas = true, opcional = true, ...resto } = props;
    return (
      <div className="space-y-1">
        <Label htmlFor={`negocio-${id}`}>
          {etiqueta}
          {opcional && <span className="font-normal text-muted-foreground"> (opcional)</span>}
        </Label>
        <Input
          id={`negocio-${id}`}
          value={datos[id]}
          disabled={!cargado || guardando}
          onChange={(e) => cambiar(id, mayusculas ? aMayusculas(e) : e.target.value)}
          className={mayusculas ? "uppercase" : undefined}
          aria-invalid={Boolean(errores[id])}
          {...resto}
        />
        {errores[id] && <p className="text-xs text-destructive">{errores[id]}</p>}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Store className="h-4 w-4" />
          Datos del negocio
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={guardar} className="space-y-4" noValidate autoComplete="off">
          {errores.general && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{errores.general}</p>
          )}
          {campo("nombreComercial", "Nombre comercial", { opcional: false, placeholder: "Ej. COMERCIAL LA ECONOMÍA", maxLength: 100 })}
          {campo("razonSocial", "Razón social", { placeholder: "Nombre legal del negocio", maxLength: 150 })}
          <div className="grid gap-4 sm:grid-cols-2">
            {campo("ruc", "RUC", {
              mayusculas: false,
              inputMode: "numeric",
              maxLength: 13,
              placeholder: "13 dígitos",
            })}
            {campo("telefono", "Teléfono", { mayusculas: false, inputMode: "tel", maxLength: 30, placeholder: "Ej. 0991234567" })}
          </div>
          {campo("direccion", "Dirección", { maxLength: 200, placeholder: "Ej. AV. AMAZONAS Y COLÓN" })}
          {campo("email", "Email", { mayusculas: false, type: "email", maxLength: 100, placeholder: "negocio@correo.com" })}

          <div className="flex items-center justify-end gap-3">
            {guardadoOk && !hayCambios && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Check className="h-3.5 w-3.5" />
                Guardado
              </span>
            )}
            <Button
              type="submit"
              size="sm"
              disabled={!cargado || guardando || !hayCambios || sinConexion}
              title={sinConexion ? MENSAJE_SIN_CONEXION : undefined}
            >
              {guardando ? "Guardando..." : "Guardar datos"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
