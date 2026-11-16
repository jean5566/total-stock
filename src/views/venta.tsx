import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { aMayusculas } from "@/lib/utils";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  History,
  Minus,
  Plus,
  Receipt,
  Undo2,
  Search,
  ShoppingCart,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AplicacionTexto, MedidaTag } from "@/components/medida-tag";
import { SelectorClienteDialog } from "@/components/selector-cliente";
import {
  DevolucionDialog,
  ETIQUETAS_REEMBOLSO,
  type CambioDirecto,
  type Devolucion,
} from "@/components/devolucion-dialog";
import {
  MAX_PESTANAS_VENTA,
  refrescarProductosVentasAbiertas,
  useVentasAbiertas,
  type CreditoCambio,
  type LineaCarrito,
  type ProductoVenta,
} from "@/hooks/use-ventas-abiertas";
import type { Cliente } from "@/components/cliente-form";
import { placeholderBusqueda, useAjustes } from "@/hooks/use-ajustes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Producto = ProductoVenta;

interface Venta {
  id: number;
  fecha: string;
  subtotalCero: number;
  subtotalIva5: number;
  subtotalIva15: number;
  iva5: number;
  iva15: number;
  total: number;
  pago: number;
  cambio: number;
  unidades: number;
  descuento: number;
  clienteNombre: string; // vacío = consumidor final
  clienteIdentificacion: string;
  totalDevuelto: number; // suma de devoluciones sobre esta venta
  credito: number; // crédito de una devolución aplicado al cobrarla (cambio de producto)
  devolucionId: number | null;
}

interface DetalleVenta {
  id: number;
  codigo: string;
  detalle: string;
  cantidad: number;
  precioUnitario: number;
  iva: string;
  subtotal: number;
  medida: string;
  precioLista: number;
  descuentoPct: number;
  descuento: number;
  devuelto: number; // unidades ya devueltas
}

interface PaginaVentas {
  ventas: Venta[];
  total: number;
  pagina: number;
  ventasHoy: number;
  montoHoy: number;
}

// Debe coincidir con VENTAS_POR_PAGINA en src-tauri/src/lib.rs
const VENTAS_POR_PAGINA = 20;

// Debe coincidir con OPCIONES_IVA / porcentaje_iva en src-tauri/src/lib.rs
const ETIQUETAS_IVA: Record<string, string> = {
  SIN_IVA: "Sin IVA",
  IVA_15: "IVA 15%",
  IVA_5: "IVA 5%",
  EXENTO: "Exento",
};
const PORCENTAJE_IVA: Record<string, number> = { IVA_15: 15, IVA_5: 5 };

const PATRON_MONTO = /^\d+(\.\d{1,2})?$/;

// El dinero se calcula en centavos (enteros), igual que en el backend, para que lo que ve el
// usuario coincida exactamente con lo que se guarda.
const aCentavos = (valor: number) => Math.round(valor * 100);
const formatear = (centavos: number) =>
  `${centavos < 0 ? "−" : ""}$${(Math.abs(centavos) / 100).toFixed(2)}`;
const calcularIva = (base: number, porcentaje: number) => Math.floor((base * porcentaje + 50) / 100);

// Calcula una línea del carrito. Debe coincidir con registrar_venta en src-tauri/src/lib.rs:
// el descuento es un monto en dólares sobre (precio × cantidad), no puede superar ese total,
// y el IVA se calcula después, sobre el neto.
function calcularLinea(linea: LineaCarrito) {
  const textoPrecio = linea.precio.trim();
  const textoDescuento = linea.descuento.trim();

  const precioOk = PATRON_MONTO.test(textoPrecio) && parseFloat(textoPrecio) > 0;
  const precio = precioOk ? aCentavos(parseFloat(textoPrecio)) : 0;
  const bruto = precio * linea.cantidad;

  const descuentoCentavos = textoDescuento === "" ? 0 : aCentavos(parseFloat(textoDescuento));
  const formatoDescuentoOk = textoDescuento === "" || PATRON_MONTO.test(textoDescuento);
  const descuentoOk = formatoDescuentoOk && descuentoCentavos <= bruto;
  const descuento = descuentoOk ? descuentoCentavos : 0;

  return {
    precioOk,
    descuentoOk,
    // Mensaje para el campo de descuento cuando no es válido
    errorDescuento: !formatoDescuentoOk
      ? "Monto inválido (máx. 2 decimales)."
      : descuentoCentavos > bruto
        ? `No puede superar ${formatear(bruto)}.`
        : "",
    precio,
    bruto,
    descuento,
    neto: bruto - descuento,
    precioEditado: precioOk && precio !== aCentavos(linea.producto.precio),
  };
}

function calcularTotales(carrito: LineaCarrito[]) {
  let subtotalCero = 0;
  let subtotalIva5 = 0;
  let subtotalIva15 = 0;
  let descuento = 0;
  let lineasInvalidas = 0;
  for (const linea of carrito) {
    const calc = calcularLinea(linea);
    if (!calc.precioOk || !calc.descuentoOk) lineasInvalidas++;
    descuento += calc.descuento;
    const porcentaje = PORCENTAJE_IVA[linea.producto.iva] ?? 0;
    if (porcentaje === 15) subtotalIva15 += calc.neto;
    else if (porcentaje === 5) subtotalIva5 += calc.neto;
    else subtotalCero += calc.neto;
  }
  const iva5 = calcularIva(subtotalIva5, 5);
  const iva15 = calcularIva(subtotalIva15, 15);
  return {
    subtotalCero,
    subtotalIva5,
    subtotalIva15,
    iva5,
    iva15,
    descuento,
    lineasInvalidas,
    total: subtotalCero + subtotalIva5 + subtotalIva15 + iva5 + iva15,
  };
}

export function VentaView() {
  // Búsqueda de productos
  const [busqueda, setBusqueda] = useState("");
  const { ajustes } = useAjustes();
  const usarMedida = ajustes.usarMedida;
  const usarAplicacion = ajustes.usarAplicacion;
  const [resultados, setResultados] = useState<Producto[]>([]);
  // Texto de la última búsqueda que respondió (evita mostrar "sin resultados" mientras se escribe)
  const [textoBuscado, setTextoBuscado] = useState("");
  // Desplegable de sugerencias bajo el buscador y la opción resaltada con el teclado (-1 = ninguna)
  const [sugerenciasAbiertas, setSugerenciasAbiertas] = useState(false);
  const [indiceActivo, setIndiceActivo] = useState(-1);
  // Productos marcados en la lista de sugerencias para enviarlos juntos al carrito
  // (p. ej. ANILLO PLANO 1/2 y ANILLO PRESIÓN 1/2). Se conservan aunque cambie la búsqueda.
  const [seleccionados, setSeleccionados] = useState<Producto[]>([]);
  // Modo "Seleccionar varios": el clic marca en vez de agregar directo. También se activa solo al
  // marcar con Ctrl/Shift+clic o Shift+Enter.
  const [modoVarios, setModoVarios] = useState(false);
  const seleccionMultiple = modoVarios || seleccionados.length > 0;
  const inputBusquedaRef = useRef<HTMLInputElement>(null);
  const listaSugerenciasRef = useRef<HTMLUListElement>(null);

  // Carrito y cobro
  // Cada pestaña es una venta en curso con su propio carrito, cliente, pago y crédito. Viven fuera de
  // esta pantalla (ver use-ventas-abiertas), así que no se pierden al ir a otra sección.
  const { pestanas, pestanaActiva, cargado, nuevaPestana, cerrarPestana, activarPestana, actualizarPestana } =
    useVentasAbiertas();
  const idActiva = pestanaActiva.id;
  const { carrito, pago, cliente, creditoCambio } = pestanaActiva;
  const setCarrito = (valor: LineaCarrito[] | ((prev: LineaCarrito[]) => LineaCarrito[])) =>
    actualizarPestana(idActiva, (p) => ({ carrito: typeof valor === "function" ? valor(p.carrito) : valor }));
  const setPago = (pago: string) => actualizarPestana(idActiva, () => ({ pago }));
  const setCliente = (cliente: Cliente | null) => actualizarPestana(idActiva, () => ({ cliente }));
  const setCreditoCambio = (creditoCambio: CreditoCambio | null) =>
    actualizarPestana(idActiva, () => ({ creditoCambio }));
  // Pestaña con productos que se quiere cerrar (pide confirmación)
  const [pestanaPorCerrar, setPestanaPorCerrar] = useState<string | null>(null);

  const [error, setError] = useState("");
  // Aviso informativo (p. ej. precios actualizados desde el catálogo)
  const [aviso, setAviso] = useState("");
  const [cobrando, setCobrando] = useState(false);
  const [ventaRegistrada, setVentaRegistrada] = useState<Venta | null>(null);
  const [selectorClienteAbierto, setSelectorClienteAbierto] = useState(false);

  // Historial
  const [historialAbierto, setHistorialAbierto] = useState(false);
  const [paginaVentas, setPaginaVentas] = useState<PaginaVentas | null>(null);
  const [ventaSeleccionada, setVentaSeleccionada] = useState<Venta | null>(null);
  const [detalleVenta, setDetalleVenta] = useState<DetalleVenta[]>([]);
  const [devolucionesVenta, setDevolucionesVenta] = useState<Devolucion[]>([]);
  const [devolucionAbierta, setDevolucionAbierta] = useState(false);
  const [devolucionRegistrada, setDevolucionRegistrada] = useState<Devolucion | null>(null);

  const totales = useMemo(() => calcularTotales(carrito), [carrito]);
  const credito = creditoCambio?.centavos ?? 0;
  const porCobrar = Math.max(0, totales.total - credito);
  // Si el crédito cubre todo, el monto recibido puede quedar vacío (= $0.00).
  const pagoVacioCubierto = pago.trim() === "" && creditoCambio !== null && credito >= totales.total;
  const pagoValido = PATRON_MONTO.test(pago.trim()) || pagoVacioCubierto;
  const pagoCentavos = pagoValido && !pagoVacioCubierto ? aCentavos(parseFloat(pago)) : 0;
  const cambioCentavos = pagoCentavos + credito - totales.total;
  const unidades = carrito.reduce((acc, l) => acc + l.cantidad, 0);

  // Las ventas abiertas guardan una copia de cada producto: al entrar (y si un cobro falla) se
  // actualizan con el precio y el stock actuales, para no cobrar un precio viejo del catálogo.
  const refrescarCarritos = async () => {
    try {
      const { quitados, preciosActualizados } = await refrescarProductosVentasAbiertas();
      const partes: string[] = [];
      if (preciosActualizados > 0) {
        partes.push(
          `Se actualizó el precio de ${preciosActualizados} producto${preciosActualizados === 1 ? "" : "s"} según el catálogo.`,
        );
      }
      if (quitados.length > 0) {
        partes.push(`Se quitaron de la venta porque ya no existen: ${quitados.join(", ")}.`);
      }
      if (partes.length > 0) setAviso(partes.join(" "));
    } catch (err) {
      console.error("No se pudieron actualizar los productos de las ventas abiertas:", err);
    }
  };

  useEffect(() => {
    if (cargado) refrescarCarritos();
  }, [cargado]);

  // Solo se muestran productos cuando hay algo escrito en el buscador.
  const buscar = async (texto: string): Promise<Producto[]> => {
    if (!texto.trim()) {
      setResultados([]);
      setTextoBuscado("");
      return [];
    }
    try {
      const lista: Producto[] = await invoke("buscar_productos_venta", {
        busqueda: texto.trim() || null,
      });
      setResultados(lista);
      setTextoBuscado(texto.trim());
      return lista;
    } catch (err) {
      console.error("Error al buscar productos:", err);
      return [];
    }
  };

  // Búsqueda con un pequeño debounce para no consultar en cada tecla.
  useEffect(() => {
    setIndiceActivo(-1);
    if (!busqueda.trim()) {
      setResultados([]);
      setTextoBuscado("");
      return;
    }
    const timeout = setTimeout(() => buscar(busqueda), 250);
    return () => clearTimeout(timeout);
  }, [busqueda]);

  // Mantiene visible la opción resaltada al moverse con las flechas
  useEffect(() => {
    if (indiceActivo < 0) return;
    listaSugerenciasRef.current
      ?.querySelector<HTMLElement>(`[data-indice="${indiceActivo}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [indiceActivo]);

  const mostrarSugerencias = sugerenciasAbiertas && busqueda.trim() !== "";
  const busquedaAlDia = textoBuscado === busqueda.trim();

  // Una sugerencia se puede elegir si tiene stock y aún no está en la venta
  const sePuedeAgregar = (p: Producto) => p.stock > 0 && cantidadEnCarrito(p.id) === 0;

  // Mueve el resaltado con las flechas saltando las opciones que no se pueden elegir
  const moverResaltado = (direccion: 1 | -1) => {
    if (resultados.length === 0) return;
    let i = indiceActivo;
    for (let paso = 0; paso < resultados.length; paso++) {
      i = (i + direccion + resultados.length) % resultados.length;
      if (sePuedeAgregar(resultados[i])) {
        setIndiceActivo(i);
        return;
      }
    }
  };

  const cantidadEnCarrito = (id: number) => carrito.find((l) => l.producto.id === id)?.cantidad ?? 0;

  // Solo agrega productos que todavía no están en la venta; si ya está, la cantidad se cambia
  // desde el carrito (botones +/–).
  const agregarAlCarrito = (producto: Producto): boolean => {
    setError("");
    if (cantidadEnCarrito(producto.id) > 0) {
      setError(`${producto.detalle} ya está en la venta. Cambia la cantidad en el carrito.`);
      return false;
    }
    if (producto.stock <= 0) {
      setError(`${producto.detalle} no tiene stock.`);
      return false;
    }
    setCarrito((prev) =>
      prev.some((l) => l.producto.id === producto.id)
        ? prev
        : [...prev, { producto, cantidad: 1, precio: producto.precio.toFixed(2), descuento: "" }],
    );
    // Limpia la búsqueda y deja el cursor listo para el siguiente producto.
    setBusqueda("");
    inputBusquedaRef.current?.focus();
    return true;
  };

  const estaSeleccionado = (id: number) => seleccionados.some((p) => p.id === id);
  const alternarSeleccion = (producto: Producto) => {
    setError("");
    setSeleccionados((prev) =>
      prev.some((p) => p.id === producto.id) ? prev.filter((p) => p.id !== producto.id) : [...prev, producto],
    );
  };

  // Envía al carrito todos los marcados (con cantidad 1) y limpia la búsqueda.
  const agregarSeleccionados = () => {
    const nuevos = seleccionados.filter(sePuedeAgregar);
    if (nuevos.length === 0) return;
    setError("");
    setCarrito((prev) => [
      ...prev,
      ...nuevos
        .filter((p) => !prev.some((l) => l.producto.id === p.id))
        .map((p) => ({ producto: p, cantidad: 1, precio: p.precio.toFixed(2), descuento: "" })),
    ]);
    setSeleccionados([]);
    setModoVarios(false);
    setBusqueda("");
    setSugerenciasAbiertas(false);
    inputBusquedaRef.current?.focus();
  };

  const cancelarSeleccion = () => {
    setSeleccionados([]);
    setModoVarios(false);
  };

  // Cambia el precio o el descuento de una línea del carrito.
  const cambiarCampo = (id: number, campo: "precio" | "descuento", valor: string) => {
    setError("");
    setCarrito((prev) => prev.map((l) => (l.producto.id === id ? { ...l, [campo]: valor } : l)));
  };

  // Al salir del campo, deja el número con 2 decimales (ej. "5" -> "5.00").
  const normalizarCampo = (id: number, campo: "precio" | "descuento") => {
    setCarrito((prev) =>
      prev.map((l) => {
        if (l.producto.id !== id) return l;
        const texto = l[campo].trim();
        if (campo === "descuento" && (texto === "" || parseFloat(texto) === 0)) return { ...l, descuento: "" };
        return PATRON_MONTO.test(texto) ? { ...l, [campo]: parseFloat(texto).toFixed(2) } : l;
      }),
    );
  };

  const cambiarCantidad = (id: number, cantidad: number) => {
    setError("");
    setCarrito((prev) =>
      prev
        .map((l) => {
          if (l.producto.id !== id) return l;
          if (cantidad > l.producto.stock) {
            setError(`No hay más stock de ${l.producto.detalle} (disponible: ${l.producto.stock}).`);
            return { ...l, cantidad: l.producto.stock };
          }
          return { ...l, cantidad };
        })
        .filter((l) => l.cantidad > 0),
    );
  };

  // Enter en el buscador: agrega la coincidencia exacta por código (lector de código de barras)
  // o el único resultado si solo hay uno.
  const manejarEnterBusqueda = async () => {
    // Con productos marcados, Enter los envía todos al carrito
    if (seleccionados.length > 0) {
      agregarSeleccionados();
      return;
    }
    const texto = busqueda.trim().toUpperCase();
    if (!texto) return;
    // Si se eligió una sugerencia con las flechas, se agrega esa
    if (mostrarSugerencias && indiceActivo >= 0 && resultados[indiceActivo]) {
      agregarAlCarrito(resultados[indiceActivo]);
      return;
    }
    const lista = await buscar(texto);
    const exacto = lista.find((p) => p.codigo.toUpperCase() === texto) ?? (lista.length === 1 ? lista[0] : null);
    if (exacto) {
      if (exacto.stock <= 0) {
        setError(`${exacto.detalle} no tiene stock.`);
        return;
      }
      agregarAlCarrito(exacto);
    } else {
      // Varios resultados: abre el desplegable y resalta el primero que se pueda elegir
      setSugerenciasAbiertas(true);
      const primero = lista.findIndex(sePuedeAgregar);
      if (primero >= 0) setIndiceActivo(primero);
    }
  };

  const vaciarCarrito = () => {
    actualizarPestana(idActiva, () => ({ carrito: [], cliente: null, pago: "" }));
    setError("");
  };

  // Al cambiar de pestaña se limpia lo que es solo de pantalla (búsqueda y errores).
  const limpiarPantalla = () => {
    setBusqueda("");
    setError("");
    cancelarSeleccion();
    setSugerenciasAbiertas(false);
    setTimeout(() => inputBusquedaRef.current?.focus(), 0);
  };

  const irAPestana = (id: string) => {
    if (id === idActiva) return;
    activarPestana(id);
    limpiarPantalla();
  };

  const abrirNuevaPestana = () => {
    if (!nuevaPestana()) {
      setError(`Puedes tener hasta ${MAX_PESTANAS_VENTA} ventas abiertas. Cobra o cierra alguna.`);
      return;
    }
    limpiarPantalla();
  };

  // Una venta vacía se cierra directo; con productos se pide confirmación.
  const pedirCerrarPestana = (id: string) => {
    const pestana = pestanas.find((p) => p.id === id);
    if (!pestana) return;
    if (pestana.carrito.length === 0 && !pestana.creditoCambio) {
      cerrarPestana(id);
      if (id === idActiva) limpiarPantalla();
    } else {
      setPestanaPorCerrar(id);
    }
  };

  const confirmarCerrarPestana = () => {
    if (!pestanaPorCerrar) return;
    const eraActiva = pestanaPorCerrar === idActiva;
    cerrarPestana(pestanaPorCerrar);
    setPestanaPorCerrar(null);
    if (eraActiva) limpiarPantalla();
  };

  // Atajos: Ctrl+T abre una venta nueva; Ctrl+Tab / Ctrl+Shift+Tab cambian de venta.
  useEffect(() => {
    const manejar = (e: KeyboardEvent) => {
      if (!e.ctrlKey || cobrando) return;
      if (e.key.toLowerCase() === "t") {
        e.preventDefault();
        abrirNuevaPestana();
      } else if (e.key === "Tab" && pestanas.length > 1) {
        e.preventDefault();
        const i = pestanas.findIndex((p) => p.id === idActiva);
        const siguiente = (i + (e.shiftKey ? -1 : 1) + pestanas.length) % pestanas.length;
        irAPestana(pestanas[siguiente].id);
      }
    };
    window.addEventListener("keydown", manejar);
    return () => window.removeEventListener("keydown", manejar);
  });

  const cobrar = async () => {
    setError("");
    if (carrito.length === 0) {
      setError("Agrega al menos un producto a la venta.");
      return;
    }
    if (totales.lineasInvalidas > 0) {
      setError("Revisa los precios y descuentos marcados en rojo.");
      return;
    }
    if (!pagoValido) {
      setError("Ingresa el monto recibido (máximo 2 decimales).");
      return;
    }
    if (cambioCentavos < 0) {
      setError("El monto recibido es menor al total.");
      return;
    }

    // Se recuerda qué pestaña se cobra, por si el usuario cambia de pestaña mientras se registra
    const idCobrada = idActiva;
    setCobrando(true);
    try {
      const venta: Venta = await invoke("registrar_venta", {
        items: carrito.map((l) => {
          const calc = calcularLinea(l);
          return { productoId: l.producto.id, cantidad: l.cantidad, precio: calc.precio / 100, descuento: calc.descuento / 100 };
        }),
        pago: pagoCentavos / 100,
        clienteId: cliente?.id ?? null,
        devolucionId: creditoCambio?.devolucionId ?? null,
      });
      setVentaRegistrada(venta);
      setAviso("");
      // La venta cobrada se cierra; si había otras abiertas se pasa a la siguiente.
      // Vaciar la búsqueda también limpia los resultados (lo hace el efecto del buscador).
      cerrarPestana(idCobrada);
      setBusqueda("");
    } catch (err) {
      console.error("Error al registrar la venta:", err);
      setError(typeof err === "string" ? err : "No se pudo registrar la venta.");
      // El stock o los precios pudieron haber cambiado: refrescamos resultados y carritos
      buscar(busqueda);
      refrescarCarritos();
    } finally {
      setCobrando(false);
    }
  };

  const cargarVentas = async (pagina: number) => {
    try {
      const resultado: PaginaVentas = await invoke("obtener_ventas", { pagina });
      setPaginaVentas(resultado);
    } catch (err) {
      console.error("Error al cargar ventas:", err);
    }
  };

  const abrirHistorial = () => {
    setVentaSeleccionada(null);
    setHistorialAbierto(true);
    cargarVentas(1);
  };

  const verDetalle = async (venta: Venta) => {
    setVentaSeleccionada(venta);
    setDetalleVenta([]);
    setDevolucionesVenta([]);
    try {
      const [lista, devoluciones] = await Promise.all([
        invoke<DetalleVenta[]>("obtener_detalle_venta", { ventaId: venta.id }),
        invoke<Devolucion[]>("obtener_devoluciones_venta", { ventaId: venta.id }),
      ]);
      setDetalleVenta(lista);
      setDevolucionesVenta(devoluciones);
    } catch (err) {
      console.error("Error al cargar el detalle de la venta:", err);
    }
  };

  const alRegistrarDevolucion = (devolucion: Devolucion, cambio?: CambioDirecto) => {
    setDevolucionAbierta(false);
    if (cambio) {
      // Cambio directo: sin confirmación, a la venta con el crédito y la búsqueda del producto devuelto
      // (usarCredito cambia la búsqueda, que se vuelve a consultar con el stock ya actualizado).
      usarCredito(devolucion, cambio.busqueda);
      if (paginaVentas) cargarVentas(paginaVentas.pagina);
      return;
    }
    setDevolucionRegistrada(devolucion);
    if (ventaSeleccionada) {
      // Recarga el detalle (cantidades devueltas) y el historial (total devuelto)
      verDetalle({
        ...ventaSeleccionada,
        totalDevuelto: (aCentavos(ventaSeleccionada.totalDevuelto) + aCentavos(devolucion.total)) / 100,
      });
      if (paginaVentas) cargarVentas(paginaVentas.pagina);
    }
    // Los productos que regresaron a stock pueden cambiar la búsqueda actual
    if (busqueda.trim()) buscar(busqueda);
  };

  // Usa el crédito de una devolución CAMBIO. Si la venta en curso ya tiene productos o un crédito
  // (probablemente de otro cliente), el cambio se hace en una pestaña nueva para no mezclarlos.
  // `busquedaInicial` deja el buscador con el producto devuelto para ver sus otras medidas o modelos.
  const usarCredito = (devolucion: Devolucion, busquedaInicial = "") => {
    setDevolucionRegistrada(null);
    setHistorialAbierto(false);
    setError("");

    const yaAplicado = pestanas.find((p) => p.creditoCambio?.devolucionId === devolucion.id);
    let destino: string | null = yaAplicado?.id ?? idActiva;
    if (yaAplicado) {
      activarPestana(yaAplicado.id);
    } else if (carrito.length > 0 || creditoCambio) {
      destino = nuevaPestana();
    }
    if (!destino) {
      setError(
        `Puedes tener hasta ${MAX_PESTANAS_VENTA} ventas abiertas. Cobra o cierra alguna y usa el crédito desde el detalle de la venta N.º ${devolucion.ventaId}.`,
      );
      return;
    }
    if (!yaAplicado) {
      actualizarPestana(destino, () => ({
        creditoCambio: {
          devolucionId: devolucion.id,
          ventaId: devolucion.ventaId,
          centavos: aCentavos(devolucion.total),
        },
      }));
    }
    // Si el texto no cambia, el debounce no vuelve a buscar: se refresca a mano (el stock cambió).
    if (busquedaInicial && busquedaInicial === busqueda) buscar(busquedaInicial);
    setBusqueda(busquedaInicial);
    setSugerenciasAbiertas(busquedaInicial !== "");
    setTimeout(() => inputBusquedaRef.current?.focus(), 0);
  };

  const unidadesPorDevolver = detalleVenta.reduce((acc, d) => acc + d.cantidad - d.devuelto, 0);

  const totalPaginasVentas = paginaVentas ? Math.max(1, Math.ceil(paginaVentas.total / VENTAS_POR_PAGINA)) : 1;

  if (!cargado) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Cargando ventas abiertas...</p>;
  }

  return (
    <div className="space-y-4">
      {/* Pestañas: una por venta en curso, con el historial a la derecha */}
      <div className="flex items-end gap-2 shadow-[inset_0_-1px_0_var(--border)]">
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
        role="tablist"
        aria-label="Ventas abiertas"
      >
        {pestanas.map((p) => {
          const activa = p.id === idActiva;
          const total = calcularTotales(p.carrito).total;
          const puedeCerrar = pestanas.length > 1 || p.carrito.length > 0;
          return (
            <div
              key={p.id}
              className={`group flex shrink-0 items-center border-b-2 text-sm transition-colors ${
                activa
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activa}
                disabled={cobrando}
                onClick={() => irAPestana(p.id)}
                className="flex max-w-[220px] items-center gap-2 py-2 pl-3 pr-1 outline-none focus-visible:underline"
                title={p.cliente ? p.cliente.nombre : undefined}
              >
                <span className={`truncate ${activa ? "font-medium" : ""}`}>
                  {p.cliente ? p.cliente.nombre : `Venta ${p.numero}`}
                </span>
                {p.carrito.length > 0 && (
                  <span className="text-xs tabular-nums text-muted-foreground">{formatear(total)}</span>
                )}
                {p.creditoCambio && <Undo2 className="size-3 shrink-0" aria-label="Con crédito de cambio" />}
              </button>
              {puedeCerrar ? (
                <button
                  type="button"
                  disabled={cobrando}
                  onClick={() => pedirCerrarPestana(p.id)}
                  className={`mr-1 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:opacity-100 ${
                    activa ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                  aria-label={`Cerrar venta ${p.numero}`}
                  title="Cerrar venta"
                >
                  <X className="size-3.5" />
                </button>
              ) : (
                <span className="w-2" />
              )}
            </div>
          );
        })}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          disabled={cobrando || pestanas.length >= MAX_PESTANAS_VENTA}
          onClick={abrirNuevaPestana}
          aria-label="Nueva venta"
          title={
            pestanas.length >= MAX_PESTANAS_VENTA
              ? `Máximo ${MAX_PESTANAS_VENTA} ventas abiertas`
              : "Nueva venta (Ctrl+T)"
          }
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
        <Button type="button" variant="ghost" size="sm" className="mb-1 shrink-0 text-muted-foreground" onClick={abrirHistorial}>
          <History className="h-4 w-4" />
          Historial de ventas
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Columna izquierda: búsqueda + carrito */}
        <div className="space-y-6 min-w-0">
          {/* overflow-visible: el desplegable de sugerencias sobresale de la tarjeta */}
          <Card className="relative z-20 overflow-visible">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">Buscar producto</CardTitle>
              {/* Por defecto un clic agrega un producto; este botón activa marcar varios a la vez */}
              <Button
                type="button"
                variant={seleccionMultiple ? "secondary" : "outline"}
                size="sm"
                aria-pressed={seleccionMultiple}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (seleccionMultiple) cancelarSeleccion();
                  else setModoVarios(true);
                  setSugerenciasAbiertas(busqueda.trim() !== "");
                  inputBusquedaRef.current?.focus();
                }}
              >
                {seleccionMultiple ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                {seleccionMultiple ? "Cancelar selección" : "Agregar varios"}
              </Button>
            </CardHeader>
            <CardContent>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={inputBusquedaRef}
                  placeholder={`${placeholderBusqueda(ajustes).replace("...", "")} (Enter agrega el código exacto)...`}
                  value={busqueda}
                  onChange={(e) => {
                    setBusqueda(aMayusculas(e));
                    setSugerenciasAbiertas(true);
                  }}
                  onFocus={() => setSugerenciasAbiertas(true)}
                  onBlur={() => setSugerenciasAbiertas(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.shiftKey) {
                      // Shift+Enter marca/desmarca la sugerencia resaltada
                      e.preventDefault();
                      const prod = mostrarSugerencias ? resultados[indiceActivo] : undefined;
                      if (prod && sePuedeAgregar(prod)) alternarSeleccion(prod);
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      manejarEnterBusqueda();
                    } else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSugerenciasAbiertas(true);
                      moverResaltado(1);
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      moverResaltado(-1);
                    } else if (e.key === "Escape") {
                      if (mostrarSugerencias) {
                        e.preventDefault();
                        setSugerenciasAbiertas(false);
                        setIndiceActivo(-1);
                      } else if (busqueda) {
                        e.preventDefault();
                        setBusqueda("");
                      }
                    }
                  }}
                  className="pl-8 pr-8 uppercase"
                  autoFocus
                  role="combobox"
                  aria-expanded={mostrarSugerencias}
                  aria-controls="sugerencias-productos"
                  aria-autocomplete="list"
                  aria-activedescendant={indiceActivo >= 0 ? `sugerencia-${indiceActivo}` : undefined}
                />
                {busqueda && (
                  <button
                    type="button"
                    // onMouseDown para que el input no pierda el foco
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setBusqueda("");
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10"
                    aria-label="Limpiar búsqueda"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}

                {mostrarSugerencias && (
                  <div className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
                    {resultados.length === 0 ? (
                      <p className="px-3 py-3 text-sm text-muted-foreground">
                        {busquedaAlDia ? "No se encontraron productos." : "Buscando..."}
                      </p>
                    ) : (
                      <ul
                        id="sugerencias-productos"
                        ref={listaSugerenciasRef}
                        role="listbox"
                        aria-multiselectable
                        className="max-h-80 overflow-y-auto py-1"
                      >
                        {resultados.map((prod, i) => {
                          // Un producto ya agregado queda bloqueado aquí: la cantidad se ajusta en el carrito
                          const enCarrito = cantidadEnCarrito(prod.id) > 0;
                          const elegible = sePuedeAgregar(prod);
                          const activo = i === indiceActivo;
                          const marcado = estaSeleccionado(prod.id);
                          return (
                            <li
                              key={prod.id}
                              id={`sugerencia-${i}`}
                              data-indice={i}
                              role="option"
                              aria-selected={marcado}
                              aria-disabled={!elegible}
                              // onMouseDown (no onClick) para elegir antes de que el input pierda el foco
                              onMouseDown={(e) => {
                                e.preventDefault();
                                if (!elegible) return;
                                // Ctrl/Shift+clic marca aunque el modo "varios" esté apagado
                                if (seleccionMultiple || e.ctrlKey || e.shiftKey || e.metaKey) {
                                  alternarSeleccion(prod);
                                } else {
                                  agregarAlCarrito(prod);
                                }
                              }}
                              onMouseEnter={() => elegible && setIndiceActivo(i)}
                              className={`flex items-center gap-3 px-3 py-2 text-sm ${
                                elegible ? "cursor-pointer" : "cursor-not-allowed opacity-60"
                              } ${activo ? "bg-accent text-accent-foreground" : marcado ? "bg-primary/5" : ""}`}
                            >
                              {seleccionMultiple && (
                                <span
                                  aria-hidden
                                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                    marcado || enCarrito
                                      ? "border-primary bg-primary text-primary-foreground"
                                      : "border-input bg-background"
                                  }`}
                                >
                                  {(marcado || enCarrito) && <Check className="h-3 w-3" />}
                                </span>
                              )}
                              <div className="min-w-0 flex-1 uppercase">
                                <div className="font-medium">
                                  {prod.detalle}
                                  {usarMedida && prod.medida && <MedidaTag medida={prod.medida} />}
                                </div>
                                <div className="font-mono text-[11px] text-muted-foreground">
                                  {prod.codigo} · {ETIQUETAS_IVA[prod.iva] ?? prod.iva}
                                </div>
                                {usarAplicacion && prod.aplicacion && <AplicacionTexto aplicacion={prod.aplicacion} />}
                              </div>
                              <div className="shrink-0 text-right">
                                <div className="font-semibold tabular-nums">{formatear(aCentavos(prod.precio))}</div>
                                <div className="text-[11px]">
                                  {enCarrito ? (
                                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                                      <Check className="h-3 w-3" />
                                      En la venta
                                    </span>
                                  ) : prod.stock <= 0 ? (
                                    <Badge variant="destructive" className="text-[11px]">Sin stock</Badge>
                                  ) : (
                                    <span className="text-muted-foreground">{prod.stock} u.</span>
                                  )}
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <div className="flex items-center justify-between gap-2 border-t bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                      <span>
                        {seleccionMultiple
                          ? "Clic o Shift+Enter para marcar · Enter envía lo marcado · Esc para cerrar"
                          : "↑ ↓ para moverte · Enter o clic para agregar · Esc para cerrar"}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                      {seleccionados.length > 0 && (
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 shrink-0"
                          // onMouseDown para que el input no pierda el foco
                          onMouseDown={(e) => {
                            e.preventDefault();
                            agregarSeleccionados();
                          }}
                        >
                          <ShoppingCart className="h-3.5 w-3.5" />
                          Agregar {seleccionados.length} al carrito
                        </Button>
                      )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Con la lista cerrada, los productos marcados siguen visibles aquí */}
              {!mostrarSugerencias && seleccionados.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
                  <span className="min-w-0 truncate uppercase text-muted-foreground">
                    {seleccionados.map((p) => p.detalle).join(" · ")}
                  </span>
                  <div className="flex shrink-0 gap-1">
                    <Button type="button" variant="ghost" size="sm" className="h-7" onClick={cancelarSeleccion}>
                      Quitar marcas
                    </Button>
                    <Button type="button" size="sm" className="h-7" onClick={agregarSeleccionados}>
                      <ShoppingCart className="h-3.5 w-3.5" />
                      Agregar {seleccionados.length} al carrito
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <ShoppingCart className="h-4 w-4" />
                Productos en la venta
              </CardTitle>
              {carrito.length > 0 && (
                <Button type="button" variant="ghost" size="sm" onClick={vaciarCarrito}>
                  Vaciar
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {carrito.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  Busca un producto y elígelo de la lista (clic o Enter).
                </p>
              ) : (
                <div className="border rounded-md overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Detalle</TableHead>
                        <TableHead className="text-center">Cantidad</TableHead>
                        <TableHead className="text-right">P. unit.</TableHead>
                        <TableHead className="text-right">Desc. $</TableHead>
                        <TableHead className="text-right">Subtotal</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {carrito.map((linea) => {
                        const { producto, cantidad } = linea;
                        const calc = calcularLinea(linea);
                        return (
                        <TableRow key={producto.id}>
                          <TableCell className="text-sm uppercase">
                            <div className="font-medium">
                              {producto.detalle}
                              {usarMedida && producto.medida && <MedidaTag medida={producto.medida} />}
                              {usarAplicacion && producto.aplicacion && <AplicacionTexto aplicacion={producto.aplicacion} />}
                            </div>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              {producto.codigo} · {ETIQUETAS_IVA[producto.iva] ?? producto.iva}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-center gap-1">
                              <Button
                                type="button"
                                variant="outline"
                                size="icon-sm"
                                // En 1 se bloquea: para quitar el producto está el botón de eliminar
                                disabled={cantidad <= 1}
                                onClick={() => cambiarCantidad(producto.id, Math.max(1, cantidad - 1))}
                                aria-label="Restar uno"
                              >
                                <Minus className="h-3 w-3" />
                              </Button>
                              <CantidadInput
                                cantidad={cantidad}
                                max={producto.stock}
                                onCambiar={(n) => cambiarCantidad(producto.id, n)}
                                aria-label={`Cantidad de ${producto.detalle}`}
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="icon-sm"
                                disabled={cantidad >= producto.stock}
                                onClick={() => cambiarCantidad(producto.id, cantidad + 1)}
                                aria-label="Sumar uno"
                              >
                                <Plus className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex flex-col items-end gap-0.5">
                              <Input
                                type="number"
                                step="0.01"
                                min="0.01"
                                inputMode="decimal"
                                value={linea.precio}
                                onChange={(e) => cambiarCampo(producto.id, "precio", e.target.value)}
                                onBlur={() => normalizarCampo(producto.id, "precio")}
                                onFocus={(e) => e.target.select()}
                                className="h-7 w-28 text-right tabular-nums"
                                aria-invalid={!calc.precioOk}
                                aria-label={`Precio unitario de ${producto.detalle}`}
                              />
                              {calc.precioEditado && (
                                <button
                                  type="button"
                                  className="text-[11px] text-primary underline-offset-2 hover:underline"
                                  onClick={() => cambiarCampo(producto.id, "precio", producto.precio.toFixed(2))}
                                  title="Volver al precio del catálogo"
                                >
                                  Lista: {formatear(aCentavos(producto.precio))}
                                </button>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              step="0.01"
                              min="0"
                              inputMode="decimal"
                              placeholder="0.00"
                              title={calc.errorDescuento || "Descuento en dólares sobre el total de la línea"}
                              value={linea.descuento}
                              onChange={(e) => cambiarCampo(producto.id, "descuento", e.target.value)}
                              onBlur={() => normalizarCampo(producto.id, "descuento")}
                              onFocus={(e) => e.target.select()}
                              className="ml-auto h-7 w-24 text-right tabular-nums"
                              aria-invalid={!calc.descuentoOk}
                              aria-label={`Descuento en dólares de ${producto.detalle}`}
                            />
                            {calc.errorDescuento && (
                              <p className="mt-0.5 text-[11px] text-destructive">{calc.errorDescuento}</p>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-sm">
                            <div className="font-semibold tabular-nums">{formatear(calc.neto)}</div>
                            {calc.descuento > 0 && (
                              <div className="text-[11px] tabular-nums text-emerald-600 dark:text-emerald-400">
                                −{formatear(calc.descuento)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => cambiarCantidad(producto.id, 0)}
                              aria-label={`Quitar ${producto.detalle} de la venta`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </TableCell>
                        </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Columna derecha: totales y cobro */}
        <Card className="h-fit lg:sticky lg:top-0">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Receipt className="h-4 w-4" />
              Resumen
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Cliente */}
            <div className="flex items-center gap-3 rounded-md border px-3 py-2">
              <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-muted-foreground">Cliente</div>
                <div className="truncate text-sm font-medium uppercase">{cliente ? cliente.nombre : "Consumidor final"}</div>
                {cliente && (
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{cliente.identificacion}</div>
                )}
              </div>
              {cliente && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setCliente(null)}
                  aria-label="Quitar cliente (consumidor final)"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => setSelectorClienteAbierto(true)}>
                {cliente ? "Cambiar" : "Elegir"}
              </Button>
            </div>

            <div className="space-y-1.5 text-sm">
              {totales.descuento > 0 && <FilaTotal etiqueta="Descuento aplicado" valor={-totales.descuento} />}
              <FilaTotal etiqueta="Subtotal 0%" valor={totales.subtotalCero} />
              {totales.subtotalIva5 > 0 && <FilaTotal etiqueta="Subtotal 5%" valor={totales.subtotalIva5} />}
              <FilaTotal etiqueta="Subtotal 15%" valor={totales.subtotalIva15} />
              {totales.iva5 > 0 && <FilaTotal etiqueta="IVA 5%" valor={totales.iva5} />}
              <FilaTotal etiqueta="IVA 15%" valor={totales.iva15} />
              <Separator className="my-2" />
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">Total</span>
                <span className="text-2xl font-extrabold tabular-nums text-primary">{formatear(totales.total)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {unidades} unidad{unidades === 1 ? "" : "es"}
              </p>
              {creditoCambio && (
                <>
                  <div className="mt-2 flex items-center gap-2 rounded-md border border-dashed px-3 py-2">
                    <Undo2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] text-muted-foreground">
                        Cambio · devolución N.º {creditoCambio.devolucionId} (venta N.º {creditoCambio.ventaId})
                      </div>
                      <div className="text-sm font-medium tabular-nums">Crédito {formatear(credito)}</div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setCreditoCambio(null)}
                      aria-label="Quitar el crédito del cambio"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex items-baseline justify-between pt-1">
                    <span className="font-semibold">Por cobrar</span>
                    <span className="text-lg font-bold tabular-nums">{formatear(porCobrar)}</span>
                  </div>
                  {credito > totales.total && carrito.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      El crédito supera el total: la diferencia ({formatear(credito - totales.total)}) se entrega como cambio.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="pago">Monto recibido</Label>
              <div className="flex gap-2">
                <Input
                  id="pago"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={pago}
                  onChange={(e) => {
                    setPago(e.target.value);
                    setError("");
                  }}
                  onBlur={() => {
                    if (PATRON_MONTO.test(pago.trim())) setPago(parseFloat(pago).toFixed(2));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      // No cobrar con el Enter que confirma una composición IME
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      cobrar();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={totales.total === 0}
                  onClick={() => setPago((porCobrar / 100).toFixed(2))}
                >
                  Exacto
                </Button>
              </div>
            </div>

            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">Cambio</span>
              <span
                className={`text-lg font-bold tabular-nums ${
                  pagoValido && cambioCentavos < 0 ? "text-destructive" : ""
                }`}
              >
                {pagoValido && carrito.length > 0 ? formatear(cambioCentavos) : "$0.00"}
              </span>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
            {aviso && (
              <p className="flex items-start justify-between gap-2 text-xs text-amber-600 dark:text-amber-400">
                <span>{aviso}</span>
                <button
                  type="button"
                  onClick={() => setAviso("")}
                  className="shrink-0 rounded p-0.5 hover:bg-foreground/10"
                  aria-label="Cerrar aviso"
                >
                  <X className="h-3 w-3" />
                </button>
              </p>
            )}
          </CardContent>
          <CardFooter>
            <Button
              type="button"
              className="w-full"
              size="lg"
              disabled={
                cobrando || carrito.length === 0 || totales.lineasInvalidas > 0 || !pagoValido || cambioCentavos < 0
              }
              onClick={cobrar}
            >
              {cobrando ? "Registrando..." : `Cobrar ${formatear(porCobrar)}`}
            </Button>
          </CardFooter>
        </Card>
      </div>

      <SelectorClienteDialog
        open={selectorClienteAbierto}
        onOpenChange={setSelectorClienteAbierto}
        seleccionado={cliente}
        onElegir={setCliente}
      />

      {/* Confirmación de venta registrada */}
      <Dialog
        open={ventaRegistrada !== null}
        onOpenChange={(open) => {
          if (!open) {
            setVentaRegistrada(null);
            inputBusquedaRef.current?.focus();
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Venta registrada</DialogTitle>
            <DialogDescription>
              {ventaRegistrada && (
                <>
                  Venta N.º {ventaRegistrada.id} · {ventaRegistrada.fecha}
                  {" · "}
                  {ventaRegistrada.clienteNombre || "Consumidor final"}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {ventaRegistrada && (
            <div className="space-y-1.5 text-sm">
              {ventaRegistrada.descuento > 0 && (
                <FilaTotal etiqueta="Descuento aplicado" valor={-aCentavos(ventaRegistrada.descuento)} />
              )}
              <FilaTotal etiqueta="Total" valor={aCentavos(ventaRegistrada.total)} />
              {ventaRegistrada.credito > 0 && (
                <FilaTotal etiqueta="Crédito por devolución" valor={-aCentavos(ventaRegistrada.credito)} />
              )}
              <FilaTotal etiqueta="Recibido" valor={aCentavos(ventaRegistrada.pago)} />
              <Separator className="my-2" />
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">Cambio</span>
                <span className="text-2xl font-extrabold tabular-nums">
                  {formatear(aCentavos(ventaRegistrada.cambio))}
                </span>
              </div>
            </div>
          )}
          <DialogFooter className="-mx-0 -mb-0 border-t-0 bg-transparent p-0 pt-2">
            <Button
              type="button"
              className="w-full sm:w-auto"
              autoFocus
              onClick={() => {
                setVentaRegistrada(null);
                inputBusquedaRef.current?.focus();
              }}
            >
              Nueva venta
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Historial de ventas */}
      <Dialog open={historialAbierto} onOpenChange={setHistorialAbierto}>
        <DialogContent className="flex h-[min(36rem,calc(100dvh-4rem))] flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {ventaSeleccionada ? `Venta N.º ${ventaSeleccionada.id}` : "Historial de ventas"}
            </DialogTitle>
            <DialogDescription>
              {ventaSeleccionada
                ? `${ventaSeleccionada.fecha} · ${ventaSeleccionada.clienteNombre ? `${ventaSeleccionada.clienteNombre} (${ventaSeleccionada.clienteIdentificacion})` : "Consumidor final"}`
                : paginaVentas &&
                  `Hoy: ${paginaVentas.ventasHoy} venta${paginaVentas.ventasHoy === 1 ? "" : "s"} · ${formatear(
                    aCentavos(paginaVentas.montoHoy),
                  )}`}
            </DialogDescription>
          </DialogHeader>

          {ventaSeleccionada ? (
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              {/* La tabla se encoge y hace scroll; totales y botones quedan siempre visibles */}
              <div className="min-h-32 flex-1 overflow-y-auto border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Detalle</TableHead>
                      <TableHead className="text-right">Cant.</TableHead>
                      <TableHead className="text-right">P. unit.</TableHead>
                      <TableHead className="text-right">Desc.</TableHead>
                      <TableHead className="text-right">Subtotal</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detalleVenta.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="text-sm uppercase">
                          <div className="font-medium">
                            {d.detalle}
                            {d.medida && <MedidaTag medida={d.medida} />}
                          </div>
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {d.codigo} · {ETIQUETAS_IVA[d.iva] ?? d.iva}
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {d.cantidad}
                          {d.devuelto > 0 && (
                            <div className="text-[11px] text-amber-600 dark:text-amber-400">dev. {d.devuelto}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          <div>{formatear(aCentavos(d.precioUnitario))}</div>
                          {d.precioLista > 0 && aCentavos(d.precioLista) !== aCentavos(d.precioUnitario) && (
                            <div className="text-[11px] text-muted-foreground line-through">
                              {formatear(aCentavos(d.precioLista))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {d.descuento > 0 ? (
                            <span className="text-emerald-600 dark:text-emerald-400">
                              −{formatear(aCentavos(d.descuento))}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm font-semibold">{formatear(aCentavos(d.subtotal))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="ml-auto w-full max-w-xs shrink-0 space-y-1.5 text-sm">
                {ventaSeleccionada.descuento > 0 && (
                  <FilaTotal etiqueta="Descuento aplicado" valor={-aCentavos(ventaSeleccionada.descuento)} />
                )}
                <FilaTotal etiqueta="Subtotal 0%" valor={aCentavos(ventaSeleccionada.subtotalCero)} />
                {ventaSeleccionada.subtotalIva5 > 0 && (
                  <FilaTotal etiqueta="Subtotal 5%" valor={aCentavos(ventaSeleccionada.subtotalIva5)} />
                )}
                <FilaTotal etiqueta="Subtotal 15%" valor={aCentavos(ventaSeleccionada.subtotalIva15)} />
                {ventaSeleccionada.iva5 > 0 && <FilaTotal etiqueta="IVA 5%" valor={aCentavos(ventaSeleccionada.iva5)} />}
                <FilaTotal etiqueta="IVA 15%" valor={aCentavos(ventaSeleccionada.iva15)} />
                <Separator className="my-2" />
                <FilaTotal etiqueta="Total" valor={aCentavos(ventaSeleccionada.total)} destacado />
                {ventaSeleccionada.credito > 0 && (
                  <FilaTotal
                    etiqueta={`Crédito dev. N.º ${ventaSeleccionada.devolucionId ?? ""}`}
                    valor={-aCentavos(ventaSeleccionada.credito)}
                  />
                )}
                <FilaTotal etiqueta="Recibido" valor={aCentavos(ventaSeleccionada.pago)} />
                <FilaTotal etiqueta="Cambio" valor={aCentavos(ventaSeleccionada.cambio)} />
                {ventaSeleccionada.totalDevuelto > 0 && (
                  <>
                    <Separator className="my-2" />
                    <FilaTotal etiqueta="Devuelto" valor={-aCentavos(ventaSeleccionada.totalDevuelto)} />
                    <FilaTotal
                      etiqueta="Total neto"
                      valor={aCentavos(ventaSeleccionada.total) - aCentavos(ventaSeleccionada.totalDevuelto)}
                      destacado
                    />
                  </>
                )}
              </div>

              {devolucionesVenta.length > 0 && (
                <div className="shrink-0 space-y-2">
                  <p className="text-sm font-semibold">Devoluciones</p>
                  <ul className="max-h-32 divide-y overflow-y-auto rounded-md border">
                    {devolucionesVenta.map((dv) => (
                      <li key={dv.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">
                            N.º {dv.id} · {dv.unidades} unidad{dv.unidades === 1 ? "" : "es"} ·{" "}
                            <span className="tabular-nums">{formatear(aCentavos(dv.total))}</span>
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {dv.fecha} · {dv.motivo} · {ETIQUETAS_REEMBOLSO[dv.reembolso]}
                            {dv.reembolso === "CAMBIO" &&
                              (dv.usadaEnVenta ? ` · usado en venta N.º ${dv.usadaEnVenta}` : " · pendiente")}
                          </div>
                        </div>
                        {dv.reembolso === "CAMBIO" && dv.usadaEnVenta === null && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={creditoCambio?.devolucionId === dv.id}
                            onClick={() => usarCredito(dv)}
                          >
                            {creditoCambio?.devolucionId === dv.id ? "En uso" : "Usar en venta"}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex shrink-0 flex-wrap justify-between gap-2">
                <Button type="button" variant="outline" onClick={() => setVentaSeleccionada(null)}>
                  <ChevronLeft className="h-4 w-4" />
                  Volver al historial
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={detalleVenta.length === 0 || unidadesPorDevolver === 0}
                  onClick={() => setDevolucionAbierta(true)}
                  title={unidadesPorDevolver === 0 && detalleVenta.length > 0 ? "Ya se devolvió todo" : undefined}
                >
                  <Undo2 className="h-4 w-4" />
                  Devolución / cambio
                </Button>
              </div>
            </div>
          ) : !paginaVentas ? (
            <p className="text-sm text-muted-foreground text-center py-4">Cargando...</p>
          ) : paginaVentas.ventas.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">Todavía no hay ventas registradas.</p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="min-h-32 flex-1 overflow-y-auto border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>N.º</TableHead>
                      <TableHead>Fecha</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead className="text-right">Unidades</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginaVentas.ventas.map((v) => (
                      <TableRow key={v.id} className="cursor-pointer" onClick={() => verDetalle(v)}>
                        <TableCell className="font-mono text-xs font-semibold">{v.id}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{v.fecha}</TableCell>
                        <TableCell className="max-w-[180px] truncate text-xs uppercase">
                          {v.clienteNombre || <span className="text-muted-foreground normal-case">Consumidor final</span>}
                        </TableCell>
                        <TableCell className="text-right text-sm">{v.unidades}</TableCell>
                        <TableCell className="text-right text-sm font-semibold">
                          {formatear(aCentavos(v.total))}
                          {v.totalDevuelto > 0 && (
                            <div className="text-[11px] font-normal text-amber-600 dark:text-amber-400">
                              dev. −{formatear(aCentavos(v.totalDevuelto))}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex shrink-0 items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {paginaVentas.total} venta{paginaVentas.total === 1 ? "" : "s"} en total
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Página {paginaVentas.pagina} de {totalPaginasVentas}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    disabled={paginaVentas.pagina <= 1}
                    onClick={() => cargarVentas(paginaVentas.pagina - 1)}
                    aria-label="Página anterior"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    disabled={paginaVentas.pagina >= totalPaginasVentas}
                    onClick={() => cargarVentas(paginaVentas.pagina + 1)}
                    aria-label="Página siguiente"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirmación para cerrar una venta que tiene productos */}
      <Dialog open={pestanaPorCerrar !== null} onOpenChange={(open) => !open && setPestanaPorCerrar(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>¿Cerrar esta venta?</DialogTitle>
            <DialogDescription>
              {(() => {
                const p = pestanas.find((x) => x.id === pestanaPorCerrar);
                if (!p) return null;
                const unidadesP = p.carrito.reduce((acc, l) => acc + l.cantidad, 0);
                return `${p.cliente ? p.cliente.nombre : `Venta ${p.numero}`} tiene ${unidadesP} unidad${
                  unidadesP === 1 ? "" : "es"
                } por ${formatear(calcularTotales(p.carrito).total)}. Se descartará sin cobrar.${
                  p.creditoCambio ? " El crédito del cambio seguirá disponible en el historial." : ""
                }`;
              })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="-mx-0 -mb-0 border-t-0 bg-transparent p-0 pt-2">
            <Button type="button" variant="outline" onClick={() => setPestanaPorCerrar(null)}>
              Volver
            </Button>
            <Button type="button" variant="destructive" onClick={confirmarCerrarPestana}>
              Cerrar sin cobrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {ventaSeleccionada && (
        <DevolucionDialog
          open={devolucionAbierta}
          onOpenChange={setDevolucionAbierta}
          ventaId={ventaSeleccionada.id}
          lineas={detalleVenta}
          devolucionesPrevias={devolucionesVenta}
          onRegistrada={alRegistrarDevolucion}
        />
      )}

      {/* Confirmación de devolución registrada */}
      <Dialog open={devolucionRegistrada !== null} onOpenChange={(open) => !open && setDevolucionRegistrada(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Devolución registrada</DialogTitle>
            <DialogDescription>
              {devolucionRegistrada &&
                `Devolución N.º ${devolucionRegistrada.id} de la venta N.º ${devolucionRegistrada.ventaId} · ${devolucionRegistrada.fecha}`}
            </DialogDescription>
          </DialogHeader>
          {devolucionRegistrada && (
            <div className="space-y-2 text-sm">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">
                  {devolucionRegistrada.reembolso === "EFECTIVO" ? "Entregar al cliente" : "Crédito para el cambio"}
                </span>
                <span className="text-2xl font-extrabold tabular-nums">
                  {formatear(aCentavos(devolucionRegistrada.total))}
                </span>
              </div>
              {devolucionRegistrada.reembolso === "CAMBIO" && (
                <p className="text-xs text-muted-foreground">
                  Agrega los productos nuevos a la venta: este crédito se descontará al cobrar. También puedes usarlo
                  más tarde desde el detalle de la venta.
                </p>
              )}
            </div>
          )}
          <DialogFooter className="-mx-0 -mb-0 border-t-0 bg-transparent p-0 pt-2">
            {devolucionRegistrada?.reembolso === "CAMBIO" ? (
              <>
                <Button type="button" variant="outline" onClick={() => setDevolucionRegistrada(null)}>
                  Más tarde
                </Button>
                <Button type="button" autoFocus onClick={() => usarCredito(devolucionRegistrada)}>
                  Hacer el cambio ahora
                </Button>
              </>
            ) : (
              <Button type="button" autoFocus onClick={() => setDevolucionRegistrada(null)}>
                Listo
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilaTotal({ etiqueta, valor, destacado }: { etiqueta: string; valor: number; destacado?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className={destacado ? "font-semibold" : "text-muted-foreground"}>{etiqueta}</span>
      <span className={`tabular-nums ${destacado ? "font-bold" : ""}`}>{formatear(valor)}</span>
    </div>
  );
}

// Campo de cantidad del carrito. Guarda su propio texto mientras se escribe, para poder borrar el
// número y escribir otro (si estuviera atado directo a la cantidad, al vaciarlo volvería al valor
// anterior). Cada número válido se aplica al momento; al salir, si quedó vacío o inválido, vuelve a
// mostrar la cantidad real (que puede haber quedado limitada por el stock).
function CantidadInput({
  cantidad,
  max,
  onCambiar,
  "aria-label": ariaLabel,
}: {
  cantidad: number;
  max: number;
  onCambiar: (cantidad: number) => void;
  "aria-label": string;
}) {
  const [texto, setTexto] = useState(String(cantidad));
  const [editando, setEditando] = useState(false);

  // Si la cantidad cambia desde fuera (botones +/–, límite de stock), se refleja cuando no se edita.
  useEffect(() => {
    if (!editando) setTexto(String(cantidad));
  }, [cantidad, editando]);

  return (
    <Input
      type="number"
      min="1"
      max={max}
      inputMode="numeric"
      value={texto}
      onFocus={(e) => {
        setEditando(true);
        e.target.select();
      }}
      onChange={(e) => {
        const valor = e.target.value;
        setTexto(valor);
        const n = parseInt(valor, 10);
        if (/^\d+$/.test(valor) && n > 0) onCambiar(n);
      }}
      onBlur={() => {
        setEditando(false);
        setTexto(String(cantidad));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="h-7 w-14 text-center"
      aria-label={ariaLabel}
    />
  );
}
