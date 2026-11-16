import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Cliente } from "@/components/cliente-form";

// Ventas en curso del punto de venta, una por pestaña. El estado vive fuera de los componentes, así
// que no se pierde al ir a otra sección, y se guarda en la base (tabla configuracion) para
// recuperarlo si se cierra la app. El stock NO se reserva: se valida y descuenta al cobrar.

export interface ProductoVenta {
  id: number;
  codigo: string;
  detalle: string;
  categoria: string;
  precio: number;
  iva: string;
  stock: number;
  medida: string;
  aplicacion: string;
}

export interface LineaCarrito {
  producto: ProductoVenta;
  cantidad: number;
  // Texto tal como lo escribe el usuario (se valida al calcular)
  precio: string; // precio unitario cobrado; arranca con el precio del catálogo
  descuento: string; // monto en dólares sobre el total de la línea; vacío = sin descuento
}

// Crédito de una devolución (reembolso CAMBIO) que se aplica a la venta.
export interface CreditoCambio {
  devolucionId: number;
  ventaId: number;
  centavos: number;
}

export interface PestanaVenta {
  id: string;
  numero: number; // "Venta 1", "Venta 2"...
  carrito: LineaCarrito[];
  pago: string;
  cliente: Cliente | null;
  creditoCambio: CreditoCambio | null;
}

export const MAX_PESTANAS_VENTA = 5;
const ESPERA_GUARDADO_MS = 300;

interface Estado {
  pestanas: PestanaVenta[];
  activa: string;
  cargado: boolean;
}

const nuevoId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const pestanaVacia = (numero: number): PestanaVenta => ({
  id: nuevoId(),
  numero,
  carrito: [],
  pago: "",
  cliente: null,
  creditoCambio: null,
});

function estadoInicial(): Estado {
  const primera = pestanaVacia(1);
  return { pestanas: [primera], activa: primera.id, cargado: false };
}

let estado: Estado = estadoInicial();
const oyentes = new Set<() => void>();
let temporizadorGuardado: ReturnType<typeof setTimeout> | undefined;
let cargando = false;
// Cambia al reiniciar (p. ej. al restaurar una copia), para descartar cargas que llegan tarde.
let generacion = 0;

function notificar() {
  oyentes.forEach((oyente) => oyente());
}

let hayCambiosSinGuardar = false;

async function guardar() {
  clearTimeout(temporizadorGuardado);
  if (!hayCambiosSinGuardar) return;
  hayCambiosSinGuardar = false;
  const datos = JSON.stringify({ pestanas: estado.pestanas, activa: estado.activa });
  try {
    await invoke("guardar_ventas_abiertas", { datos });
  } catch (err) {
    console.error("No se pudieron guardar las ventas abiertas:", err);
  }
}

function programarGuardado() {
  if (!estado.cargado) return;
  hayCambiosSinGuardar = true;
  clearTimeout(temporizadorGuardado);
  temporizadorGuardado = setTimeout(guardar, ESPERA_GUARDADO_MS);
}

// Guarda ya lo pendiente (sin esperar el retraso). Se usa antes de cerrar la ventana, para no
// perder el último cambio del carrito si se cierra justo después de editarlo.
export function guardarVentasAbiertasAhora(): Promise<void> {
  return guardar();
}

function cambiarEstado(nuevo: Estado) {
  estado = nuevo;
  notificar();
  programarGuardado();
}

// Valida lo leído de la base; si algo no cuadra se descarta (mejor una venta vacía que un error).
function interpretar(texto: string): Omit<Estado, "cargado"> | null {
  try {
    const datos = JSON.parse(texto);
    if (!datos || !Array.isArray(datos.pestanas)) return null;
    const pestanas: PestanaVenta[] = datos.pestanas
      .filter((p: unknown): p is PestanaVenta => {
        const x = p as PestanaVenta;
        return !!x && typeof x.id === "string" && typeof x.numero === "number" && Array.isArray(x.carrito);
      })
      .slice(0, MAX_PESTANAS_VENTA)
      .map((p: PestanaVenta) => ({
        id: p.id,
        numero: p.numero,
        carrito: p.carrito.filter((l) => l && l.producto && typeof l.cantidad === "number" && l.cantidad > 0),
        pago: typeof p.pago === "string" ? p.pago : "",
        cliente: p.cliente ?? null,
        creditoCambio: p.creditoCambio ?? null,
      }));
    if (pestanas.length === 0) return null;
    const activa = pestanas.some((p) => p.id === datos.activa) ? datos.activa : pestanas[0].id;
    return { pestanas, activa };
  } catch {
    return null;
  }
}

async function cargar() {
  if (estado.cargado || cargando) return;
  cargando = true;
  const gen = generacion;
  try {
    const texto = await invoke<string>("obtener_ventas_abiertas");
    if (gen !== generacion) return;
    const guardado = texto ? interpretar(texto) : null;
    estado = guardado ? { ...guardado, cargado: true } : { ...estado, cargado: true };
    notificar();
  } catch (err) {
    console.error("No se pudieron recuperar las ventas abiertas:", err);
    if (gen === generacion) {
      estado = { ...estado, cargado: true };
      notificar();
    }
  } finally {
    if (gen === generacion) cargando = false;
  }
}

// Se llama cuando cambia la base de datos (restaurar copia o eliminarla): descarta lo que hay en
// memoria sin guardarlo, y la próxima vez se vuelve a leer de la base nueva.
export function reiniciarVentasAbiertas() {
  clearTimeout(temporizadorGuardado);
  hayCambiosSinGuardar = false;
  generacion++;
  cargando = false;
  estado = estadoInicial();
  notificar();
}

function suscribir(oyente: () => void) {
  oyentes.add(oyente);
  return () => oyentes.delete(oyente);
}

// --- Acciones ---------------------------------------------------------------------------------

function actualizarPestana(id: string, cambio: (p: PestanaVenta) => Partial<PestanaVenta>) {
  cambiarEstado({
    ...estado,
    pestanas: estado.pestanas.map((p) => (p.id === id ? { ...p, ...cambio(p) } : p)),
  });
}

// Abre una venta nueva y la activa. Devuelve su id, o null si ya se llegó al máximo.
function nuevaPestana(): string | null {
  if (estado.pestanas.length >= MAX_PESTANAS_VENTA) return null;
  // Usa el número libre más bajo, para que no crezca sin fin ("Venta 1", "Venta 2"...)
  const usados = new Set(estado.pestanas.map((p) => p.numero));
  let numero = 1;
  while (usados.has(numero)) numero++;
  const pestana = pestanaVacia(numero);
  cambiarEstado({ ...estado, pestanas: [...estado.pestanas, pestana], activa: pestana.id });
  return pestana.id;
}

// Cierra una venta. Si era la activa, pasa a la vecina; si era la única, deja una vacía.
function cerrarPestana(id: string) {
  const indice = estado.pestanas.findIndex((p) => p.id === id);
  if (indice < 0) return;
  const restantes = estado.pestanas.filter((p) => p.id !== id);
  if (restantes.length === 0) {
    const vacia = pestanaVacia(1);
    cambiarEstado({ ...estado, pestanas: [vacia], activa: vacia.id });
    return;
  }
  const activa = estado.activa === id ? restantes[Math.min(indice, restantes.length - 1)].id : estado.activa;
  cambiarEstado({ ...estado, pestanas: restantes, activa });
}

function activarPestana(id: string) {
  if (estado.activa === id || !estado.pestanas.some((p) => p.id === id)) return;
  cambiarEstado({ ...estado, activa: id });
}

// Ids de todos los productos que hay en las ventas abiertas.
function idsEnCarritos(): number[] {
  return [...new Set(estado.pestanas.flatMap((p) => p.carrito.map((l) => l.producto.id)))];
}

export interface ResultadoRefresco {
  quitados: string[]; // detalle de los productos que ya no existen (se quitan de la venta)
  preciosActualizados: number; // líneas cuyo precio siguió al nuevo precio del catálogo
}

// Reemplaza la copia guardada de cada producto por sus datos actuales del catálogo. Si el precio de
// una línea no se había editado a mano (sigue igual al precio de lista anterior), pasa al precio nuevo;
// si se editó, se respeta. Los productos eliminados del catálogo se quitan de la venta.
function aplicarProductosActuales(actuales: ProductoVenta[]): ResultadoRefresco {
  const porId = new Map(actuales.map((p) => [p.id, p]));
  const quitados: string[] = [];
  let preciosActualizados = 0;
  let huboCambios = false;

  const pestanas = estado.pestanas.map((pestana) => {
    let cambio = false;
    const carrito: LineaCarrito[] = [];
    for (const linea of pestana.carrito) {
      const actual = porId.get(linea.producto.id);
      if (!actual) {
        quitados.push(linea.producto.detalle);
        cambio = true;
        continue;
      }
      const precioSinEditar = linea.precio.trim() === linea.producto.precio.toFixed(2);
      const precio = precioSinEditar ? actual.precio.toFixed(2) : linea.precio;
      if (precio !== linea.precio) preciosActualizados++;
      const productoCambio = (Object.keys(actual) as (keyof ProductoVenta)[]).some(
        (k) => actual[k] !== linea.producto[k],
      );
      if (precio !== linea.precio || productoCambio) cambio = true;
      carrito.push({ ...linea, producto: actual, precio });
    }
    if (!cambio) return pestana;
    huboCambios = true;
    return { ...pestana, carrito };
  });

  if (huboCambios) cambiarEstado({ ...estado, pestanas });
  return { quitados, preciosActualizados };
}

// Consulta el catálogo y actualiza los productos de todas las ventas abiertas.
export async function refrescarProductosVentasAbiertas(): Promise<ResultadoRefresco> {
  const ids = idsEnCarritos();
  if (ids.length === 0) return { quitados: [], preciosActualizados: 0 };
  const gen = generacion;
  const actuales = await invoke<ProductoVenta[]>("obtener_productos_por_ids", { ids });
  // Si mientras tanto se restauró o eliminó la base, estos datos ya no aplican.
  if (gen !== generacion) return { quitados: [], preciosActualizados: 0 };
  return aplicarProductosActuales(actuales);
}

export function useVentasAbiertas() {
  const actual = useSyncExternalStore(suscribir, () => estado);

  useEffect(() => {
    cargar();
  }, [actual.cargado]);

  const pestanaActiva = actual.pestanas.find((p) => p.id === actual.activa) ?? actual.pestanas[0];

  return {
    pestanas: actual.pestanas,
    pestanaActiva,
    cargado: actual.cargado,
    nuevaPestana,
    cerrarPestana,
    activarPestana,
    actualizarPestana,
  };
}
