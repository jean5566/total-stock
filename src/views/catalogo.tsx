import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { aMayusculas } from "@/lib/utils";
import { Check, ChevronLeft, ChevronRight, Pencil, Plus, Search, Tag, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { TablaSkeleton } from "@/components/tabla-skeleton";
import { AltoAnimado } from "@/components/alto-animado";
import { AplicacionTexto, MedidaTag } from "@/components/medida-tag";
import { placeholderBusqueda, useAjustes } from "@/hooks/use-ajustes";
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
  DialogTrigger,
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

// Debe coincidir con PRODUCTOS_POR_PAGINA en src-tauri/src/lib.rs
const PRODUCTOS_POR_PAGINA = 20;
// Valor sentinela del filtro de categoría para "sin filtro" (el Select no admite value="")
const TODAS_CATEGORIAS = "TODAS";

// Debe coincidir con OPCIONES_IVA en src-tauri/src/lib.rs
const OPCIONES_IVA = [
  { valor: "SIN_IVA", etiqueta: "Sin IVA" },
  { valor: "IVA_15", etiqueta: "IVA 15%" },
  { valor: "IVA_5", etiqueta: "IVA 5%" },
  { valor: "EXENTO", etiqueta: "Exento" },
] as const;

function etiquetaIva(valor: string): string {
  return OPCIONES_IVA.find((op) => op.valor === valor)?.etiqueta ?? valor;
}

interface RespuestaPaginada {
  productos: Producto[];
  total: number;
  pagina: number;
}

interface ErroresFormulario {
  codigo?: string;
  detalle?: string;
  categoria?: string;
  precio?: string;
  general?: string;
}

export function CatalogoView() {
  const [dialogAbierto, setDialogAbierto] = useState(false);
  const [dialogCategoriasAbierto, setDialogCategoriasAbierto] = useState(false);

  // Nuevos estados y actualizados
  const [codigo, setCodigo] = useState("");
  const [detalle, setDetalle] = useState("");
  const [categoria, setCategoria] = useState("");
  const [precio, setPrecio] = useState("");
  const [iva, setIva] = useState<string>(OPCIONES_IVA[0].valor);
  const [medida, setMedida] = useState("");
  const [aplicacion, setAplicacion] = useState("");
  // El campo "Medida" solo aparece si está activado en Configuración
  const { ajustes } = useAjustes();
  const usarMedida = ajustes.usarMedida;
  const usarAplicacion = ajustes.usarAplicacion;
  const [productos, setProductos] = useState<Producto[]>([]);
  const [pagina, setPagina] = useState(1);
  const [totalProductos, setTotalProductos] = useState(0);
  // true hasta que llega la primera página (muestra un esqueleto en vez de "No hay productos")
  const [cargandoInicial, setCargandoInicial] = useState(true);

  // Búsqueda y filtro por categoría (se resuelven en SQL, no en el frontend)
  const [busqueda, setBusqueda] = useState("");
  const [categoriaFiltro, setCategoriaFiltro] = useState(TODAS_CATEGORIAS);

  // Producto que se está editando (null = creando uno nuevo)
  const [productoEditando, setProductoEditando] = useState<Producto | null>(null);
  // Producto pendiente de confirmación de borrado
  const [productoAEliminar, setProductoAEliminar] = useState<Producto | null>(null);

  // Categorías disponibles para el selector (se pueden ampliar desde el formulario)
  const [categorias, setCategorias] = useState<string[]>([]);
  const [nuevaCategoria, setNuevaCategoria] = useState("");
  const [errorCategoria, setErrorCategoria] = useState("");
  // Categoría que se está renombrando (null = ninguna) y el texto del nuevo nombre
  const [categoriaEditando, setCategoriaEditando] = useState<string | null>(null);
  const [textoCategoriaEditada, setTextoCategoriaEditada] = useState("");

  // Errores de validación del formulario de producto, por campo
  const [errores, setErrores] = useState<ErroresFormulario>({});

  const aplicarResultado = (resultado: RespuestaPaginada) => {
    setProductos(resultado.productos);
    setTotalProductos(resultado.total);
    setPagina(resultado.pagina);
  };

  // Sube con cada resultado de un filtro/página distinto; se usa como key para el fundido de entrada
  const [versionDatos, setVersionDatos] = useState(0);
  // Id de la última consulta: si el usuario cambia de filtro rápido, se descartan las respuestas viejas
  const ultimaConsulta = useRef(0);

  const cargarPagina = async (paginaDestino: number) => {
    const consulta = ++ultimaConsulta.current;
    try {
      const resultado: RespuestaPaginada = await invoke("obtener_productos", {
        pagina: paginaDestino,
        busqueda: busqueda.trim() || null,
        categoriaFiltro: categoriaFiltro !== TODAS_CATEGORIAS ? categoriaFiltro : null,
      });
      if (consulta !== ultimaConsulta.current) return;
      setVersionDatos((v) => v + 1);
      aplicarResultado(resultado);
    } catch (err) {
      console.error("Error al cargar productos:", err);
    } finally {
      if (consulta === ultimaConsulta.current) setCargandoInicial(false);
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

  // Primera carga inmediata. Solo la búsqueda (texto) lleva debounce, para no disparar una consulta
  // SQL en cada tecla; el filtro de categoría se aplica al instante.
  const esPrimerRender = useRef(true);
  const busquedaPrevia = useRef(busqueda);
  useEffect(() => {
    if (esPrimerRender.current) {
      esPrimerRender.current = false;
      cargarPagina(1);
      cargarCategorias();
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
  }, [busqueda, categoriaFiltro]);

  const limpiarFormulario = () => {
    setCodigo("");
    setDetalle("");
    setCategoria("");
    setPrecio("");
    setIva(OPCIONES_IVA[0].valor);
    setMedida("");
    setAplicacion("");
    setProductoEditando(null);
    setErrores({});
  };

  const validarFormulario = (): boolean => {
    const nuevosErrores: ErroresFormulario = {};

    const codigoLimpio = codigo.trim();
    if (!codigoLimpio) {
      nuevosErrores.codigo = "El código es obligatorio.";
    } else if (!/^[A-Z0-9-_]{2,30}$/.test(codigoLimpio)) {
      nuevosErrores.codigo = "Usa solo letras, números, '-' o '_' (2 a 30 caracteres).";
    }

    const detalleLimpio = detalle.trim();
    if (!detalleLimpio) {
      nuevosErrores.detalle = "El detalle es obligatorio.";
    } else if (detalleLimpio.length < 2) {
      nuevosErrores.detalle = "El detalle debe tener al menos 2 caracteres.";
    }

    if (!categoria) {
      nuevosErrores.categoria = "Selecciona una categoría.";
    }

    const precioTexto = precio.trim();
    const precioNum = parseFloat(precioTexto);
    if (!precioTexto || Number.isNaN(precioNum)) {
      nuevosErrores.precio = "Ingresa un precio válido.";
    } else if (!/^\d+(\.\d{1,2})?$/.test(precioTexto)) {
      nuevosErrores.precio = "El precio admite máximo 2 decimales.";
    } else if (precioNum <= 0) {
      nuevosErrores.precio = "El precio debe ser mayor a 0.";
    }

    setErrores(nuevosErrores);
    return Object.keys(nuevosErrores).length === 0;
  };

  const abrirEdicion = (prod: Producto) => {
    setProductoEditando(prod);
    setCodigo(prod.codigo);
    setDetalle(prod.detalle);
    setCategoria(prod.categoria);
    setPrecio(prod.precio.toFixed(2));
    setIva(prod.iva);
    setMedida(prod.medida ?? "");
    setAplicacion(prod.aplicacion ?? "");
    setErrores({});

    // Si la categoría del producto ya no está en la lista, la restauramos
    setCategorias((prev) => (prev.includes(prod.categoria) ? prev : [...prev, prod.categoria]));

    setDialogAbierto(true);
  };

  const agregarCategoria = async () => {
    const valor = nuevaCategoria.trim().toUpperCase();
    if (!valor) {
      setErrorCategoria("Escribe un nombre de categoría.");
      return;
    }
    if (categorias.includes(valor)) {
      setErrorCategoria("Esa categoría ya existe.");
      return;
    }

    try {
      const lista: string[] = await invoke("agregar_categoria", { nombre: valor });
      setCategorias(lista);
      setNuevaCategoria("");
      setErrorCategoria("");
    } catch (err) {
      console.error("Error al agregar categoría:", err);
      setErrorCategoria(typeof err === "string" ? err : "No se pudo agregar la categoría.");
    }
  };

  const iniciarRenombrado = (cat: string) => {
    setCategoriaEditando(cat);
    setTextoCategoriaEditada(cat);
    setErrorCategoria("");
  };

  const cancelarRenombrado = () => {
    setCategoriaEditando(null);
    setTextoCategoriaEditada("");
    setErrorCategoria("");
  };

  const renombrarCategoria = async () => {
    if (!categoriaEditando) return;
    const actual = categoriaEditando;
    const nuevo = textoCategoriaEditada.trim().toUpperCase();
    if (!nuevo) {
      setErrorCategoria("Escribe un nombre de categoría.");
      return;
    }
    if (nuevo === actual) {
      cancelarRenombrado();
      return;
    }
    if (categorias.includes(nuevo)) {
      setErrorCategoria("Ya existe una categoría con ese nombre.");
      return;
    }

    try {
      const lista: string[] = await invoke("renombrar_categoria", {
        nombreActual: actual,
        nombreNuevo: nuevo,
      });
      setCategorias(lista);
      if (categoria === actual) setCategoria(nuevo);
      cancelarRenombrado();
      // Los productos de esa categoría cambiaron de nombre de categoría: refrescamos la tabla
      if (categoriaFiltro === actual) {
        setCategoriaFiltro(nuevo); // dispara la recarga vía useEffect
      } else {
        cargarPagina(pagina);
      }
    } catch (err) {
      console.error("Error al renombrar categoría:", err);
      setErrorCategoria(typeof err === "string" ? err : "No se pudo renombrar la categoría.");
    }
  };

  const eliminarCategoria = async (valor: string) => {
    try {
      const lista: string[] = await invoke("eliminar_categoria", { nombre: valor });
      setCategorias(lista);
      if (categoria === valor) setCategoria("");
    } catch (err) {
      console.error("Error al eliminar categoría:", err);
      setErrorCategoria(typeof err === "string" ? err : "No se pudo eliminar la categoría.");
    }
  };

  const manejarGuardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validarFormulario()) return;

    const datos = {
      codigo: codigo.trim(),
      detalle: detalle.trim(),
      categoria,
      precio: Math.round(parseFloat(precio) * 100) / 100,
      iva,
      // Con el campo desactivado no se envía, así se conserva la medida que ya tuviera el producto
      medida: usarMedida ? medida.trim() : null,
      aplicacion: usarAplicacion ? aplicacion.trim() : null,
    };

    const filtros = {
      busqueda: busqueda.trim() || null,
      categoriaFiltro: categoriaFiltro !== TODAS_CATEGORIAS ? categoriaFiltro : null,
    };

    try {
      const resultado: RespuestaPaginada = productoEditando
        ? await invoke("actualizar_producto", { id: productoEditando.id, pagina, ...datos, ...filtros })
        : await invoke("agregar_producto", { ...datos, ...filtros });

      aplicarResultado(resultado);
      limpiarFormulario();
      setDialogAbierto(false);
    } catch (err) {
      console.error("Error al guardar el producto:", err);
      const mensaje = typeof err === "string" ? err : "No se pudo guardar el producto.";
      setErrores((prev) => ({
        ...prev,
        general: mensaje,
        codigo: mensaje.toLowerCase().includes("código") ? mensaje : prev.codigo,
      }));
    }
  };

  const manejarEliminar = async () => {
    if (!productoAEliminar) return;

    try {
      const resultado: RespuestaPaginada = await invoke("eliminar_producto", {
        id: productoAEliminar.id,
        pagina,
        busqueda: busqueda.trim() || null,
        categoriaFiltro: categoriaFiltro !== TODAS_CATEGORIAS ? categoriaFiltro : null,
      });

      aplicarResultado(resultado);
      setProductoAEliminar(null);
    } catch (err) {
      console.error("Error al eliminar el producto:", err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          <Dialog
            open={dialogCategoriasAbierto}
            onOpenChange={(open) => {
              setDialogCategoriasAbierto(open);
              if (!open) {
                setNuevaCategoria("");
                setErrorCategoria("");
                setCategoriaEditando(null);
                setTextoCategoriaEditada("");
              }
            }}
          >
            <DialogTrigger render={<Button variant="outline" />}>
              <Tag className="h-4 w-4" />
              Gestionar Categorías
            </DialogTrigger>

            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Gestionar Categorías</DialogTitle>
                <DialogDescription>
                  Agrega, renombra o elimina las categorías disponibles para los productos. Al
                  renombrar, los productos de esa categoría se actualizan automáticamente.
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-wrap gap-2">
                {categorias.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No hay categorías registradas.</p>
                ) : (
                  categorias.map((cat) =>
                    categoriaEditando === cat ? (
                      <div key={cat} className="flex items-center gap-1">
                        <Input
                          autoFocus
                          value={textoCategoriaEditada}
                          onChange={(e) => {
                            setTextoCategoriaEditada(aMayusculas(e));
                            setErrorCategoria("");
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                              renombrarCategoria();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              e.stopPropagation();
                              cancelarRenombrado();
                            }
                          }}
                          className="h-7 w-40 uppercase text-xs"
                          aria-label={`Nuevo nombre para ${cat}`}
                          aria-invalid={Boolean(errorCategoria)}
                        />
                        <Button
                          type="button"
                          size="icon-sm"
                          onClick={renombrarCategoria}
                          aria-label="Guardar nombre"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={cancelarRenombrado}
                          aria-label="Cancelar"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : (
                    <Badge key={cat} variant="secondary" className="gap-1 pr-1">
                      {cat}
                      <button
                        type="button"
                        onClick={() => iniciarRenombrado(cat)}
                        className="ml-1 rounded-full p-0.5 hover:bg-foreground/10"
                        aria-label={`Renombrar categoría ${cat}`}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => eliminarCategoria(cat)}
                        className="ml-1 rounded-full p-0.5 hover:bg-foreground/10"
                        aria-label={`Eliminar categoría ${cat}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                    )
                  )
                )}
              </div>

              <div className="space-y-1">
                <div className="flex gap-2 pt-2">
                  <Input
                    placeholder="Nueva categoría"
                    value={nuevaCategoria}
                    onChange={(e) => {
                      setNuevaCategoria(aMayusculas(e));
                      setErrorCategoria("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        agregarCategoria();
                      }
                    }}
                    className="uppercase"
                    aria-invalid={Boolean(errorCategoria)}
                  />
                  <Button type="button" onClick={agregarCategoria}>
                    <Plus className="h-4 w-4" />
                    Agregar
                  </Button>
                </div>
                {errorCategoria && <p className="text-xs text-destructive">{errorCategoria}</p>}
              </div>
            </DialogContent>
          </Dialog>

          <Dialog
            open={dialogAbierto}
            onOpenChange={(open) => {
              setDialogAbierto(open);
              if (!open) limpiarFormulario();
            }}
          >
            <DialogTrigger render={<Button />}>
              <Plus className="h-4 w-4" />
              Agregar Producto
            </DialogTrigger>

            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>{productoEditando ? "Editar Producto" : "Nuevo Producto"}</DialogTitle>
                <DialogDescription>
                  {productoEditando
                    ? "Modifica los campos y guarda los cambios del producto."
                    : "Completa los campos para registrar un producto en el catálogo. El stock inicial es 0 y se agrega después desde Inventario."}
                </DialogDescription>
              </DialogHeader>

              <form onSubmit={manejarGuardar} className="space-y-4" noValidate autoComplete="off">
                {errores.general && (
                  <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {errores.general}
                  </p>
                )}
                <div className="space-y-1">
                  <Label htmlFor="codigo">Código / SKU</Label>
                  <Input
                    id="codigo"
                    placeholder="Ej. PROD-001"
                    value={codigo}
                    onChange={(e) => {
                      setCodigo(aMayusculas(e));
                      setErrores((prev) => ({ ...prev, codigo: undefined, general: undefined }));
                    }}
                    className="uppercase"
                    aria-invalid={Boolean(errores.codigo)}
                  />
                  {errores.codigo && <p className="text-xs text-destructive">{errores.codigo}</p>}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="detalle">Detalle / Nombre</Label>
                  <Input
                    id="detalle"
                    placeholder="Ej. Mouse Logi"
                    value={detalle}
                    onChange={(e) => {
                      setDetalle(aMayusculas(e));
                      setErrores((prev) => ({ ...prev, detalle: undefined }));
                    }}
                    className="uppercase"
                    aria-invalid={Boolean(errores.detalle)}
                  />
                  {errores.detalle && <p className="text-xs text-destructive">{errores.detalle}</p>}
                </div>
                {usarMedida && (
                  <div className="space-y-1">
                    <Label htmlFor="medida">
                      Medida <span className="font-normal text-muted-foreground">(opcional)</span>
                    </Label>
                    <Input
                      id="medida"
                      placeholder="Ej. 500 ML, 1 KG o TALLA M"
                      value={medida}
                      maxLength={60}
                      onChange={(e) => setMedida(aMayusculas(e))}
                      className="uppercase"
                    />
                  </div>
                )}
                {usarAplicacion && (
                  <div className="space-y-1">
                    <Label htmlFor="aplicacion">
                      Aplicación <span className="font-normal text-muted-foreground">(opcional)</span>
                    </Label>
                    <Input
                      id="aplicacion"
                      placeholder="Ej. IPHONE 13, IPHONE 14"
                      value={aplicacion}
                      maxLength={250}
                      onChange={(e) => setAplicacion(aMayusculas(e))}
                      className="uppercase"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Para qué sirve o con qué es compatible. Separa varios con comas.
                    </p>
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="categoria">Categoría</Label>
                  <Select
                    value={categoria}
                    onValueChange={(val) => {
                      setCategoria(val ?? "");
                      setErrores((prev) => ({ ...prev, categoria: undefined }));
                    }}
                  >
                    <SelectTrigger id="categoria" aria-invalid={Boolean(errores.categoria)}>
                      <SelectValue placeholder="Selecciona una categoría" />
                    </SelectTrigger>
                    <SelectContent>
                      {categorias.map((cat) => (
                        <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errores.categoria && <p className="text-xs text-destructive">{errores.categoria}</p>}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="precio">Precio</Label>
                  <Input
                    id="precio"
                    type="number"
                    step="0.01"
                    min="0.01"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={precio}
                    onChange={(e) => {
                      setPrecio(e.target.value);
                      setErrores((prev) => ({ ...prev, precio: undefined }));
                    }}
                    onBlur={() => {
                      // Normaliza a 2 decimales (ej. "5" -> "5.00", "5.5" -> "5.50")
                      if (/^\d+(\.\d{1,2})?$/.test(precio.trim())) {
                        setPrecio(parseFloat(precio).toFixed(2));
                      }
                    }}
                    aria-invalid={Boolean(errores.precio)}
                  />
                  {errores.precio && <p className="text-xs text-destructive">{errores.precio}</p>}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="iva">IVA</Label>
                  <Select value={iva} onValueChange={(val) => setIva(val ?? OPCIONES_IVA[0].valor)}>
                    <SelectTrigger id="iva">
                      <SelectValue placeholder="Selecciona el tipo de IVA" />
                    </SelectTrigger>
                    <SelectContent>
                      {OPCIONES_IVA.map((op) => (
                        <SelectItem key={op.valor} value={op.valor}>{op.etiqueta}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <DialogFooter className="-mx-0 -mb-0 border-t-0 bg-transparent p-0 pt-2">
                  <Button type="submit" className="w-full sm:w-auto">
                    {productoEditando ? "Actualizar Producto" : "Guardar Producto"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
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
        {(busqueda || categoriaFiltro !== TODAS_CATEGORIAS) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setBusqueda("");
              setCategoriaFiltro(TODAS_CATEGORIAS);
            }}
          >
            <X className="h-3.5 w-3.5" />
            Limpiar
          </Button>
        )}
      </div>

      {/* Tabla de productos */}
      <Card>
        <CardHeader><CardTitle className="text-base">Lista de Productos</CardTitle></CardHeader>
        <CardContent>
          <AltoAnimado>
          {/* La key cambia con cada resultado nuevo, así el contenido entra con un fundido suave */}
          <div key={versionDatos} className="animate-in fade-in duration-300 motion-reduce:animate-none">
          {cargandoInicial ? (
            <TablaSkeleton />
          ) : productos.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {busqueda || categoriaFiltro !== TODAS_CATEGORIAS
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
                    <TableHead className="text-right">Precio</TableHead>
                    <TableHead className="text-center">IVA</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
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
                      <TableCell className="text-right text-sm">${prod.precio.toFixed(2)}</TableCell>
                      <TableCell className="text-center text-sm">
                        <Badge variant={prod.iva === "SIN_IVA" ? "outline" : "secondary"} className="text-[11px]">
                          {etiquetaIva(prod.iva)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-sm font-semibold">{prod.stock} u.</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => abrirEdicion(prod)}
                            aria-label={`Editar ${prod.detalle}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setProductoAEliminar(prod)}
                            aria-label={`Eliminar ${prod.detalle}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
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

      {/* Confirmación de borrado */}
      <AlertDialog
        open={productoAEliminar !== null}
        onOpenChange={(open) => {
          if (!open) setProductoAEliminar(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar producto?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta acción eliminará <strong>{productoAEliminar?.detalle}</strong> del catálogo de forma permanente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={manejarEliminar}
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/30"
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
