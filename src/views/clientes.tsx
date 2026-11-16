import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight, History, Mail, Pencil, Phone, Plus, Search, Trash2, X } from "lucide-react";
import { aMayusculas } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TablaSkeleton } from "@/components/tabla-skeleton";
import { ClienteFormDialog, etiquetaTipoIdentificacion, type Cliente } from "@/components/cliente-form";

interface PaginaClientes {
  clientes: Cliente[];
  total: number;
  pagina: number;
}

interface VentaCliente {
  id: number;
  fecha: string;
  total: number;
  descuento: number;
  unidades: number;
  totalDevuelto: number;
}

// Debe coincidir con CLIENTES_POR_PAGINA en src-tauri/src/lib.rs
const CLIENTES_POR_PAGINA = 20;

const formatoDinero = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dinero = (valor: number) => `$${formatoDinero.format(valor)}`;

export function ClientesView() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(1);
  const [busqueda, setBusqueda] = useState("");
  const [cargandoInicial, setCargandoInicial] = useState(true);

  // Formulario (crear / editar)
  const [formAbierto, setFormAbierto] = useState(false);
  const [clienteEditando, setClienteEditando] = useState<Cliente | null>(null);

  // Eliminar
  const [clienteAEliminar, setClienteAEliminar] = useState<Cliente | null>(null);

  // Historial de compras
  const [clienteHistorial, setClienteHistorial] = useState<Cliente | null>(null);
  const [compras, setCompras] = useState<VentaCliente[]>([]);
  const [cargandoCompras, setCargandoCompras] = useState(false);

  // Id de la última consulta: si se escribe rápido, se descartan las respuestas viejas
  const ultimaConsulta = useRef(0);

  const cargarPagina = async (destino: number) => {
    const consulta = ++ultimaConsulta.current;
    try {
      const r: PaginaClientes = await invoke("obtener_clientes", {
        pagina: destino,
        busqueda: busqueda.trim() || null,
      });
      if (consulta !== ultimaConsulta.current) return;
      setClientes(r.clientes);
      setTotal(r.total);
      setPagina(r.pagina);
    } catch (err) {
      console.error("Error al cargar clientes:", err);
    } finally {
      setCargandoInicial(false);
    }
  };

  // Primera carga inmediata; luego, búsqueda con debounce.
  const esPrimerRender = useRef(true);
  useEffect(() => {
    if (esPrimerRender.current) {
      esPrimerRender.current = false;
      cargarPagina(1);
      return;
    }
    const t = setTimeout(() => cargarPagina(1), 300);
    return () => clearTimeout(t);
  }, [busqueda]);

  const abrirNuevo = () => {
    setClienteEditando(null);
    setFormAbierto(true);
  };

  const abrirEdicion = (c: Cliente) => {
    setClienteEditando(c);
    setFormAbierto(true);
  };

  const confirmarEliminar = async () => {
    if (!clienteAEliminar) return;
    try {
      await invoke("eliminar_cliente", { id: clienteAEliminar.id });
      setClienteAEliminar(null);
      cargarPagina(pagina);
    } catch (err) {
      console.error("Error al eliminar el cliente:", err);
    }
  };

  const abrirHistorial = async (c: Cliente) => {
    setClienteHistorial(c);
    setCargandoCompras(true);
    try {
      const lista: VentaCliente[] = await invoke("obtener_ventas_cliente", { clienteId: c.id });
      setCompras(lista);
    } catch (err) {
      console.error("Error al cargar las compras:", err);
      setCompras([]);
    } finally {
      setCargandoCompras(false);
    }
  };

  const totalPaginas = Math.max(1, Math.ceil(total / CLIENTES_POR_PAGINA));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" onClick={abrirNuevo}>
          <Plus className="h-4 w-4" />
          Nuevo cliente
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar por nombre, identificación o teléfono..."
            value={busqueda}
            onChange={(e) => setBusqueda(aMayusculas(e))}
            className="pl-8 uppercase"
          />
        </div>
        {busqueda && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setBusqueda("")}>
            <X className="h-3.5 w-3.5" />
            Limpiar
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lista de Clientes</CardTitle>
        </CardHeader>
        <CardContent>
          {cargandoInicial ? (
            <TablaSkeleton />
          ) : clientes.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {busqueda ? "No se encontraron clientes con esa búsqueda." : "Todavía no hay clientes registrados."}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Identificación</TableHead>
                    <TableHead>Nombre</TableHead>
                    <TableHead>Contacto</TableHead>
                    <TableHead className="text-right">Compras</TableHead>
                    <TableHead className="text-right">Total comprado</TableHead>
                    <TableHead className="text-right">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clientes.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="font-mono text-xs font-semibold">{c.identificacion}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {etiquetaTipoIdentificacion(c.tipoIdentificacion)}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm uppercase">
                        <div className="font-medium">{c.nombre}</div>
                        {c.direccion && (
                          <div className="max-w-[260px] truncate text-[11px] text-muted-foreground" title={c.direccion}>
                            {c.direccion}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {!c.telefono && !c.email && "—"}
                        {c.telefono && (
                          <div className="flex items-center gap-1">
                            <Phone className="h-3 w-3" aria-hidden="true" />
                            {c.telefono}
                          </div>
                        )}
                        {c.email && (
                          <div className="flex items-center gap-1">
                            <Mail className="h-3 w-3" aria-hidden="true" />
                            {c.email}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {c.compras > 0 ? c.compras : <Badge variant="outline" className="text-[11px]">Nuevo</Badge>}
                      </TableCell>
                      <TableCell className="text-right text-sm font-semibold tabular-nums">
                        {dinero(c.totalComprado)}
                        {c.ultimaCompra && (
                          <div className="text-[11px] font-normal text-muted-foreground">
                            Última: {c.ultimaCompra.slice(0, 10)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => abrirHistorial(c)}
                            aria-label={`Ver compras de ${c.nombre}`}
                          >
                            <History className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => abrirEdicion(c)}
                            aria-label={`Editar ${c.nombre}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setClienteAEliminar(c)}
                            aria-label={`Eliminar ${c.nombre}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>

        {total > 0 && (
          <CardFooter className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {total} cliente{total === 1 ? "" : "s"} en total
            </p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Página {pagina} de {totalPaginas}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={pagina <= 1}
                onClick={() => cargarPagina(pagina - 1)}
                aria-label="Página anterior"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={pagina >= totalPaginas}
                onClick={() => cargarPagina(pagina + 1)}
                aria-label="Página siguiente"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>

      <ClienteFormDialog
        open={formAbierto}
        onOpenChange={setFormAbierto}
        cliente={clienteEditando}
        onGuardado={() => cargarPagina(clienteEditando ? pagina : 1)}
        sugerencia={clienteEditando ? undefined : busqueda}
      />

      {/* Confirmación de borrado */}
      <AlertDialog
        open={clienteAEliminar !== null}
        onOpenChange={(open) => {
          if (!open) setClienteAEliminar(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar cliente?</AlertDialogTitle>
            <AlertDialogDescription>
              Se eliminará <strong>{clienteAEliminar?.nombre}</strong>.
              {clienteAEliminar && clienteAEliminar.compras > 0 &&
                ` Sus ${clienteAEliminar.compras} compras se conservan en el historial de ventas.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmarEliminar}>
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Historial de compras */}
      <Dialog
        open={clienteHistorial !== null}
        onOpenChange={(open) => {
          if (!open) setClienteHistorial(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Compras del cliente</DialogTitle>
            <DialogDescription>
              {clienteHistorial && (
                <>
                  <strong className="uppercase">{clienteHistorial.nombre}</strong> · {clienteHistorial.compras} compra
                  {clienteHistorial.compras === 1 ? "" : "s"} · {dinero(clienteHistorial.totalComprado)}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {cargandoCompras ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Cargando...</p>
          ) : compras.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Este cliente todavía no tiene compras.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>N.º</TableHead>
                    <TableHead>Fecha</TableHead>
                    <TableHead className="text-right">Unidades</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {compras.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-mono text-xs font-semibold">{v.id}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{v.fecha}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{v.unidades}</TableCell>
                      <TableCell className="text-right text-sm font-semibold tabular-nums">
                        {dinero(v.total)}
                        {v.descuento > 0 && (
                          <div className="text-[11px] font-normal text-muted-foreground">
                            desc. {dinero(v.descuento)}
                          </div>
                        )}
                        {v.totalDevuelto > 0 && (
                          <div className="text-[11px] font-normal text-amber-600 dark:text-amber-400">
                            dev. −{dinero(v.totalDevuelto)}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
