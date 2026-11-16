import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { aMayusculas } from "@/lib/utils";
import {
  AlertTriangle,
  Boxes,
  ChevronLeft,
  ChevronRight,
  History,
  PackageMinus,
  PackagePlus,
  PackageX,
  Search,
  Wallet,
} from "lucide-react";
import { dinero, entero, Indicador, plural } from "@/components/reporte-ui";
import { Badge } from "@/components/ui/badge";
import { AplicacionTexto, MedidaTag } from "@/components/medida-tag";
import { placeholderBusqueda, useAjustes } from "@/hooks/use-ajustes";
import { TablaSkeleton } from "@/components/tabla-skeleton";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AltoAnimado } from "@/components/alto-animado";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Producto {
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

interface RespuestaPaginada {
  productos: Producto[];
  total: number;
  pagina: number;
}

interface Movimiento {
  id: number;
  tipo: "ENTRADA" | "SALIDA" | "VENTA" | "DEVOLUCION";
  cantidad: number;
  stockResultante: number;
  fecha: string;
}

const ETIQUETAS_MOVIMIENTO: Record<Movimiento["tipo"], string> = {
  ENTRADA: "Entrada",
  SALIDA: "Salida manual",
  VENTA: "Venta",
  DEVOLUCION: "Devolución",
};

// Totales de todo el catálogo (sin filtros). Coincide con ResumenInventario en src-tauri/src/lib.rs
interface ResumenInventario {
  totalProductos: number;
  productosSinStock: number;
  productosStockBajo: number;
  unidadesEnStock: number;
  valorInventario: number;
}

// Debe coincidir con PRODUCTOS_POR_PAGINA en src-tauri/src/lib.rs
const PRODUCTOS_POR_PAGINA = 20;
// Valor sentinela del filtro de categoría para "sin filtro" (el Select no admite value="")
const TODAS_CATEGORIAS = "TODAS";
// Debajo de esta cantidad (sin llegar a 0) se marca como "Stock bajo"
const UMBRAL_STOCK_BAJO = 5;
// Filtro por estado del stock. Los valores deben coincidir con construir_filtro en src-tauri/src/lib.rs
const TODOS_STOCK = "TODOS";
const FILTROS_STOCK = [
  { valor: TODOS_STOCK, etiqueta: "Todo el stock" },
  { valor: "SIN_STOCK", etiqueta: "Sin stock" },
  { valor: "BAJO", etiqueta: `Stock bajo (1-${UMBRAL_STOCK_BAJO})` },
  { valor: "CON_STOCK", etiqueta: "Con stock" },
  { valor: "OK", etiqueta: "Stock OK" },
];

export function InventarioView() {
  const [productos, setProductos] = useState<Producto[]>([]);
  const { ajustes } = useAjustes();
  const usarMedida = ajustes.usarMedida;
  const usarAplicacion = ajustes.usarAplicacion;
  const [pagina, setPagina] = useState(1);
  const [totalProductos, setTotalProductos] = useState(0);
  // true hasta que llega la primera página (muestra un esqueleto en vez de "No hay productos")
  const [cargandoInicial, setCargandoInicial] = useState(true);
  const [categorias, setCategorias] = useState<string[]>([]);

  const [busqueda, setBusqueda] = useState("");
  const [categoriaFiltro, setCategoriaFiltro] = useState(TODAS_CATEGORIAS);
  const [stockFiltro, setStockFiltro] = useState(TODOS_STOCK);
  const [resumen, setResumen] = useState<ResumenInventario | null>(null);

  // Producto al que se le está agregando/quitando stock (null = diálogo cerrado)
  const [productoParaStock, setProductoParaStock] = useState<Producto | null>(null);
  const [modoStock, setModoStock] = useState<"ENTRADA" | "SALIDA">("ENTRADA");
  const [cantidadStock, setCantidadStock] = useState("");
  const [errorStock, setErrorStock] = useState("");
  const [guardandoStock, setGuardandoStock] = useState(false);

  // Historial de movimientos del producto seleccionado
  const [productoParaHistorial, setProductoParaHistorial] = useState<Producto | null>(null);
  const [movimientos, setMovimientos] = useState<Movimiento[]>([]);
  const [cargandoHistorial, setCargandoHistorial] = useState(false);

  // true mientras se espera una página nueva (la tabla anterior sigue visible hasta que llega)
  const [cargando, setCargando] = useState(false);
  // Sube con cada resultado de un filtro/página distinto; se usa como key para el fundido de entrada
  const [versionDatos, setVersionDatos] = useState(0);
  // Id de la última consulta: si el usuario cambia de filtro rápido, se descartan las respuestas viejas
  const ultimaConsulta = useRef(0);

  const cargarPagina = async (paginaDestino: number) => {
    const consulta = ++ultimaConsulta.current;
    setCargando(true);
    try {
      const resultado: RespuestaPaginada = await invoke("obtener_inventario", {
        pagina: paginaDestino,
        busqueda: busqueda.trim() || null,
        categoriaFiltro: categoriaFiltro !== TODAS_CATEGORIAS ? categoriaFiltro : null,
        estadoStock: stockFiltro !== TODOS_STOCK ? stockFiltro : null,
      });
      if (consulta !== ultimaConsulta.current) return;
      setVersionDatos((v) => v + 1);
      setProductos(resultado.productos);
      setTotalProductos(resultado.total);
      setPagina(resultado.pagina);
    } catch (err) {
      console.error("Error al cargar el inventario:", err);
    } finally {
      if (consulta === ultimaConsulta.current) {
        setCargando(false);
        setCargandoInicial(false);
      }
    }
  };

  const cargarCategorias = async () => {
    try {
      const lista: string[] = await invoke("obtener_categorias");
      setCategorias(lista);
    } catch (err) {
      console.error("Error al cargar categorías:", err);
    }
  };

  const cargarResumen = async () => {
    try {
      setResumen(await invoke<ResumenInventario>("obtener_resumen_inventario"));
    } catch (err) {
      console.error("Error al cargar el resumen del inventario:", err);
    }
  };

  // Clic en un indicador: aplica su filtro; un segundo clic sobre el mismo lo quita.
  const alternarFiltroStock = (valor: string) =>
    setStockFiltro((actual) => (actual === valor ? TODOS_STOCK : valor));

  const abrirDialogoStock =(prod: Producto, modo: "ENTRADA" | "SALIDA") => {
    setProductoParaStock(prod);
    setModoStock(modo);
    setCantidadStock("");
    setErrorStock("");
  };

  const manejarGuardarStock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productoParaStock) return;

    // Solo enteros positivos: "2.7" o "1e3" no se truncan en silencio
    const texto = cantidadStock.trim();
    const cantidad = Number(texto);
    if (!/^\d+$/.test(texto) || cantidad <= 0 || cantidad > 1_000_000) {
      setErrorStock("Ingresa una cantidad entera entre 1 y 1,000,000.");
      return;
    }

    setGuardandoStock(true);
    try {
      const comando = modoStock === "ENTRADA" ? "agregar_stock" : "quitar_stock";
      const resultado: RespuestaPaginada = await invoke(comando, {
        id: productoParaStock.id,
        cantidad,
        pagina,
        busqueda: busqueda.trim() || null,
        categoriaFiltro: categoriaFiltro !== TODAS_CATEGORIAS ? categoriaFiltro : null,
        estadoStock: stockFiltro !== TODOS_STOCK ? stockFiltro : null,
      });
      setProductos(resultado.productos);
      setTotalProductos(resultado.total);
      setPagina(resultado.pagina);
      setProductoParaStock(null);
      cargarResumen();
    } catch (err) {
      console.error("Error al actualizar stock:", err);
      setErrorStock(typeof err === "string" ? err : "No se pudo actualizar el stock.");
    } finally {
      setGuardandoStock(false);
    }
  };

  const abrirHistorial = async (prod: Producto) => {
    setProductoParaHistorial(prod);
    setCargandoHistorial(true);
    try {
      const lista: Movimiento[] = await invoke("obtener_movimientos", { productoId: prod.id });
      setMovimientos(lista);
    } catch (err) {
      console.error("Error al cargar el historial:", err);
      setMovimientos([]);
    } finally {
      setCargandoHistorial(false);
    }
  };

  // Primera carga inmediata. Solo la búsqueda (texto) lleva debounce, para no disparar una consulta
  // SQL en cada tecla; los filtros por clic (indicadores, selects) se aplican al instante.
  const esPrimerRender = useRef(true);
  const busquedaPrevia = useRef(busqueda);
  useEffect(() => {
    if (esPrimerRender.current) {
      esPrimerRender.current = false;
      cargarPagina(1);
      cargarCategorias();
      cargarResumen();
      return;
    }
    const cambioBusqueda = busquedaPrevia.current !== busqueda;
    busquedaPrevia.current = busqueda;
    if (!cambioBusqueda) {
      cargarPagina(1);
      return;
    }
    const timeout = setTimeout(() => cargarPagina(1), 300);
    return () => clearTimeout(timeout);
  }, [busqueda, categoriaFiltro, stockFiltro]);

  return (
    <div className="space-y-6">
      {/* Indicadores de stock (todo el catálogo). Los de estado filtran la tabla al hacer clic. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {resumen ? (
          <>
            <Indicador
              titulo="Total de productos"
              icono={Boxes}
              valor={entero(resumen.totalProductos)}
              pie="Ver todos"
              onClick={() => setStockFiltro(TODOS_STOCK)}
              activo={stockFiltro === TODOS_STOCK}
            />
            <Indicador
              titulo="Sin stock"
              icono={PackageX}
              valor={entero(resumen.productosSinStock)}
              pie={resumen.productosSinStock > 0 ? "Reponer cuanto antes" : "Ninguno agotado"}
              onClick={() => alternarFiltroStock("SIN_STOCK")}
              activo={stockFiltro === "SIN_STOCK"}
            />
            <Indicador
              titulo="Stock bajo"
              icono={AlertTriangle}
              valor={entero(resumen.productosStockBajo)}
              pie={`Entre 1 y ${UMBRAL_STOCK_BAJO} unidades`}
              onClick={() => alternarFiltroStock("BAJO")}
              activo={stockFiltro === "BAJO"}
            />
            <Indicador
              titulo="Valor del inventario"
              icono={Wallet}
              valor={dinero(resumen.valorInventario)}
              junto={plural(resumen.unidadesEnStock, "unidad", "unidades")}
              pie="A precio de venta"
            />
          </>
        ) : (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} size="sm">
              <CardContent className="space-y-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-6 w-20" />
                <Skeleton className="h-3 w-32" />
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Búsqueda y filtro por categoría */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={placeholderBusqueda(ajustes)}
            value={busqueda}
            onChange={(e) => setBusqueda(aMayusculas(e))}
            className="pl-8 uppercase"
          />
        </div>
        <Select value={categoriaFiltro} onValueChange={(val) => setCategoriaFiltro(val ?? TODAS_CATEGORIAS)}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Categoría" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TODAS_CATEGORIAS}>Todas las categorías</SelectItem>
            {categorias.map((cat) => (
              <SelectItem key={cat} value={cat}>{cat}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={stockFiltro} onValueChange={(val) => setStockFiltro(val ?? TODOS_STOCK)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Stock">
              {(val: string) => FILTROS_STOCK.find((f) => f.valor === val)?.etiqueta ?? "Stock"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {FILTROS_STOCK.map((f) => (
              <SelectItem key={f.valor} value={f.valor}>{f.etiqueta}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(busqueda || categoriaFiltro !== TODAS_CATEGORIAS || stockFiltro !== TODOS_STOCK) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setBusqueda("");
              setCategoriaFiltro(TODAS_CATEGORIAS);
              setStockFiltro(TODOS_STOCK);
            }}
          >
            Limpiar
          </Button>
        )}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Stock Actual</CardTitle></CardHeader>
        <CardContent aria-busy={cargando}>
          <AltoAnimado>
          {/* La key cambia con cada resultado nuevo, así el contenido entra con un fundido suave */}
          <div key={versionDatos} className="animate-in fade-in duration-300 motion-reduce:animate-none">
          {cargandoInicial ? (
            <TablaSkeleton />
          ) : productos.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {busqueda || categoriaFiltro !== TODAS_CATEGORIAS || stockFiltro !== TODOS_STOCK
                ? "No se encontraron productos con esos filtros."
                : "No hay productos registrados."}
            </p>
          ) : (
            <div className="border rounded-md overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Código</TableHead>
                    <TableHead>Detalle</TableHead>
                    <TableHead>Categoría</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead className="text-center">Estado</TableHead>
                    <TableHead className="text-right">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {productos.map((prod) => (
                    <TableRow key={prod.id}>
                      <TableCell className="font-mono text-xs font-semibold uppercase">{prod.codigo}</TableCell>
                      <TableCell className="font-medium text-sm uppercase">
                        {prod.detalle}
                        {usarMedida && prod.medida && <MedidaTag medida={prod.medida} />}
                        {usarAplicacion && prod.aplicacion && <AplicacionTexto aplicacion={prod.aplicacion} />}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground uppercase">{prod.categoria}</TableCell>
                      <TableCell className="text-right text-sm font-semibold">{prod.stock} u.</TableCell>
                      <TableCell className="text-center text-sm">
                        {prod.stock === 0 ? (
                          <Badge variant="destructive" className="text-[11px]">Sin stock</Badge>
                        ) : prod.stock <= UMBRAL_STOCK_BAJO ? (
                          <Badge variant="outline" className="border-amber-500 text-[11px] text-amber-600 dark:text-amber-400">
                            Stock bajo
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[11px]">OK</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => abrirDialogoStock(prod, "ENTRADA")}
                            aria-label={`Agregar stock a ${prod.detalle}`}
                          >
                            <PackagePlus className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => abrirDialogoStock(prod, "SALIDA")}
                            aria-label={`Quitar stock a ${prod.detalle}`}
                          >
                            <PackageMinus className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => abrirHistorial(prod)}
                            aria-label={`Ver historial de ${prod.detalle}`}
                          >
                            <History className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          </div>
          </AltoAnimado>
        </CardContent>

        {totalProductos > 0 && (
          <CardFooter className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {totalProductos} producto{totalProductos === 1 ? "" : "s"} en total
            </p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Página {pagina} de {Math.max(1, Math.ceil(totalProductos / PRODUCTOS_POR_PAGINA))}
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
                disabled={pagina >= Math.ceil(totalProductos / PRODUCTOS_POR_PAGINA)}
                onClick={() => cargarPagina(pagina + 1)}
                aria-label="Página siguiente"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>

      {/* Agregar / quitar stock */}
      <Dialog
        open={productoParaStock !== null}
        onOpenChange={(open) => {
          if (!open) setProductoParaStock(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{modoStock === "ENTRADA" ? "Agregar Stock" : "Quitar Stock"}</DialogTitle>
            <DialogDescription>
              {productoParaStock && (
                <>
                  <strong>{productoParaStock.detalle}</strong> — stock actual: {productoParaStock.stock} u.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={manejarGuardarStock} className="space-y-4" noValidate autoComplete="off">
            <div className="space-y-1">
              <Label htmlFor="cantidad-stock">Cantidad a {modoStock === "ENTRADA" ? "agregar" : "quitar"}</Label>
              <Input
                id="cantidad-stock"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                placeholder="0"
                value={cantidadStock}
                onChange={(e) => {
                  setCantidadStock(e.target.value);
                  setErrorStock("");
                }}
                aria-invalid={Boolean(errorStock)}
                autoFocus
              />
              {errorStock && <p className="text-xs text-destructive">{errorStock}</p>}
            </div>

            <DialogFooter className="-mx-0 -mb-0 border-t-0 bg-transparent p-0 pt-2">
              <Button type="submit" className="w-full sm:w-auto" disabled={guardandoStock}>
                {guardandoStock ? "Guardando..." : modoStock === "ENTRADA" ? "Agregar" : "Quitar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Historial de movimientos */}
      <Dialog
        open={productoParaHistorial !== null}
        onOpenChange={(open) => {
          if (!open) setProductoParaHistorial(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Historial de Movimientos</DialogTitle>
            <DialogDescription>
              {productoParaHistorial && <strong>{productoParaHistorial.detalle}</strong>}
            </DialogDescription>
          </DialogHeader>

          {cargandoHistorial ? (
            <p className="text-sm text-muted-foreground text-center py-4">Cargando...</p>
          ) : movimientos.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Todavía no hay movimientos registrados para este producto.
            </p>
          ) : (
            <div className="max-h-80 overflow-y-auto border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead className="text-right">Cantidad</TableHead>
                    <TableHead className="text-right">Stock resultante</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movimientos.map((mov) => (
                    <TableRow key={mov.id}>
                      <TableCell className="text-xs text-muted-foreground">{mov.fecha}</TableCell>
                      <TableCell className="text-xs">{ETIQUETAS_MOVIMIENTO[mov.tipo] ?? mov.tipo}</TableCell>
                      <TableCell
                        className={`text-right text-sm font-semibold ${
                          mov.tipo === "ENTRADA" || mov.tipo === "DEVOLUCION" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
                        }`}
                      >
                        {mov.tipo === "ENTRADA" || mov.tipo === "DEVOLUCION" ? "+" : "-"}
                        {mov.cantidad}
                      </TableCell>
                      <TableCell className="text-right text-sm">{mov.stockResultante} u.</TableCell>
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
