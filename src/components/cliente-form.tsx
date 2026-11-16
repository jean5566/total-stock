import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { aMayusculas } from "@/lib/utils";

// Debe coincidir con el struct Cliente en src-tauri/src/lib.rs
export interface Cliente {
  id: number;
  tipoIdentificacion: string;
  identificacion: string;
  nombre: string;
  telefono: string;
  email: string;
  direccion: string;
  fechaRegistro: string;
  compras: number;
  totalComprado: number;
  ultimaCompra: string | null;
}

// Debe coincidir con TIPOS_IDENTIFICACION en src-tauri/src/lib.rs
export const TIPOS_IDENTIFICACION = [
  { valor: "CEDULA", etiqueta: "Cédula" },
  { valor: "RUC", etiqueta: "RUC" },
  { valor: "PASAPORTE", etiqueta: "Pasaporte" },
] as const;

export function etiquetaTipoIdentificacion(valor: string) {
  return TIPOS_IDENTIFICACION.find((t) => t.valor === valor)?.etiqueta ?? valor;
}

// Misma regla que cedula_valida en src-tauri/src/lib.rs
function cedulaValida(cedula: string) {
  if (!/^\d{10}$/.test(cedula)) return false;
  const d = cedula.split("").map(Number);
  const provincia = d[0] * 10 + d[1];
  if (!((provincia >= 1 && provincia <= 24) || provincia === 30) || d[2] >= 6) return false;
  const suma = d.slice(0, 9).reduce((acc, x, i) => {
    const p = i % 2 === 0 ? x * 2 : x;
    return acc + (p > 9 ? p - 9 : p);
  }, 0);
  return (10 - (suma % 10)) % 10 === d[9];
}

function errorIdentificacion(tipo: string, valor: string): string | undefined {
  if (!valor) return "La identificación es obligatoria.";
  if (tipo === "CEDULA" && !cedulaValida(valor)) return "La cédula no es válida (revisa los 10 dígitos).";
  if (tipo === "RUC" && !/^\d{13}$/.test(valor)) return "El RUC debe tener 13 dígitos.";
  if (tipo === "PASAPORTE" && !/^[A-Z0-9]{3,20}$/.test(valor)) return "Usa de 3 a 20 letras o números.";
  return undefined;
}

interface Errores {
  identificacion?: string;
  nombre?: string;
  email?: string;
  general?: string;
}

interface ClienteFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // null = crear uno nuevo
  cliente: Cliente | null;
  onGuardado: (cliente: Cliente) => void;
  // Identificación o nombre ya escrito en un buscador, para no tener que repetirlo
  sugerencia?: string;
}

export function ClienteFormDialog({ open, onOpenChange, cliente, onGuardado, sugerencia }: ClienteFormDialogProps) {
  const [tipo, setTipo] = useState<string>("CEDULA");
  const [identificacion, setIdentificacion] = useState("");
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [email, setEmail] = useState("");
  const [direccion, setDireccion] = useState("");
  const [errores, setErrores] = useState<Errores>({});
  const [guardando, setGuardando] = useState(false);

  // Carga los datos cada vez que se abre el diálogo
  useEffect(() => {
    if (!open) return;
    setErrores({});
    if (cliente) {
      setTipo(cliente.tipoIdentificacion);
      setIdentificacion(cliente.identificacion);
      setNombre(cliente.nombre);
      setTelefono(cliente.telefono);
      setEmail(cliente.email);
      setDireccion(cliente.direccion);
    } else {
      const texto = (sugerencia ?? "").trim().toUpperCase();
      const esNumero = /^\d+$/.test(texto);
      setTipo(esNumero && texto.length === 13 ? "RUC" : "CEDULA");
      setIdentificacion(esNumero ? texto : "");
      setNombre(esNumero ? "" : texto);
      setTelefono("");
      setEmail("");
      setDireccion("");
    }
  }, [open, cliente, sugerencia]);

  const validar = () => {
    const nuevos: Errores = {};
    nuevos.identificacion = errorIdentificacion(tipo, identificacion.trim());
    if (nombre.trim().length < 2) nuevos.nombre = "El nombre es obligatorio.";
    const correo = email.trim();
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) nuevos.email = "El email no es válido.";
    const limpios = Object.fromEntries(Object.entries(nuevos).filter(([, v]) => v)) as Errores;
    setErrores(limpios);
    return Object.keys(limpios).length === 0;
  };

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validar()) return;
    setGuardando(true);
    try {
      const datos = {
        tipoIdentificacion: tipo,
        identificacion: identificacion.trim(),
        nombre: nombre.trim(),
        telefono: telefono.trim(),
        email: email.trim(),
        direccion: direccion.trim(),
      };
      const guardado: Cliente = cliente
        ? await invoke("actualizar_cliente", { id: cliente.id, ...datos })
        : await invoke("agregar_cliente", datos);
      onGuardado(guardado);
      onOpenChange(false);
    } catch (err) {
      console.error("Error al guardar el cliente:", err);
      const mensaje = typeof err === "string" ? err : "No se pudo guardar el cliente.";
      setErrores((prev) => ({
        ...prev,
        general: mensaje,
        identificacion: mensaje.toLowerCase().includes("identificación") ? mensaje : prev.identificacion,
      }));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{cliente ? "Editar Cliente" : "Nuevo Cliente"}</DialogTitle>
          <DialogDescription>Los campos con * son obligatorios.</DialogDescription>
        </DialogHeader>

        <form onSubmit={guardar} className="space-y-3" noValidate autoComplete="off">
          {errores.general && !errores.identificacion && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{errores.general}</p>
          )}

          <div className="grid grid-cols-[130px_1fr] gap-2">
            <div className="space-y-1">
              <Label htmlFor="cli-tipo">Tipo *</Label>
              <Select
                value={tipo}
                onValueChange={(v) => {
                  setTipo(v ?? "CEDULA");
                  setErrores((p) => ({ ...p, identificacion: undefined }));
                }}
              >
                <SelectTrigger id="cli-tipo" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIPOS_IDENTIFICACION.map((t) => (
                    <SelectItem key={t.valor} value={t.valor}>
                      {t.etiqueta}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cli-identificacion">Identificación *</Label>
              <Input
                id="cli-identificacion"
                value={identificacion}
                inputMode={tipo === "PASAPORTE" ? "text" : "numeric"}
                maxLength={tipo === "PASAPORTE" ? 20 : tipo === "RUC" ? 13 : 10}
                placeholder={tipo === "RUC" ? "13 dígitos" : tipo === "CEDULA" ? "10 dígitos" : "Ej. A1234567"}
                onChange={(e) => {
                  setIdentificacion(aMayusculas(e));
                  setErrores((p) => ({ ...p, identificacion: undefined, general: undefined }));
                }}
                className="font-mono uppercase"
                aria-invalid={Boolean(errores.identificacion)}
              />
            </div>
          </div>
          {errores.identificacion && <p className="-mt-2 text-xs text-destructive">{errores.identificacion}</p>}

          <div className="space-y-1">
            <Label htmlFor="cli-nombre">Nombre / Razón social *</Label>
            <Input
              id="cli-nombre"
              value={nombre}
              maxLength={150}
              placeholder="Ej. JUAN PÉREZ"
              onChange={(e) => {
                setNombre(aMayusculas(e));
                setErrores((p) => ({ ...p, nombre: undefined }));
              }}
              className="uppercase"
              aria-invalid={Boolean(errores.nombre)}
            />
            {errores.nombre && <p className="text-xs text-destructive">{errores.nombre}</p>}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="cli-telefono">Teléfono</Label>
              <Input
                id="cli-telefono"
                value={telefono}
                maxLength={20}
                inputMode="tel"
                placeholder="Ej. 0991234567"
                onChange={(e) => setTelefono(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cli-email">Email</Label>
              <Input
                id="cli-email"
                type="email"
                value={email}
                maxLength={120}
                placeholder="correo@ejemplo.com"
                onChange={(e) => {
                  setEmail(e.target.value);
                  setErrores((p) => ({ ...p, email: undefined }));
                }}
                aria-invalid={Boolean(errores.email)}
              />
              {errores.email && <p className="text-xs text-destructive">{errores.email}</p>}
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="cli-direccion">Dirección</Label>
            <Input
              id="cli-direccion"
              value={direccion}
              maxLength={200}
              placeholder="Ej. AV. AMAZONAS Y COLÓN"
              onChange={(e) => setDireccion(aMayusculas(e))}
              className="uppercase"
            />
          </div>

          <DialogFooter className="-mx-0 -mb-0 border-t-0 bg-transparent p-0 pt-2">
            <Button type="submit" className="w-full sm:w-auto" disabled={guardando}>
              {guardando ? "Guardando..." : cliente ? "Actualizar Cliente" : "Guardar Cliente"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
