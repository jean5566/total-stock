import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar, Vista } from "@/components/app-sidebar";
import { ModeToggle } from "@/components/mode-toggle";
import { TitleBar } from "@/components/window-controls";
import { DashboardView } from "@/views/dashboard";
import { CatalogoView } from "@/views/catalogo";
import { InventarioView } from "@/views/inventario";
import { VentaView } from "@/views/venta";
import { ClientesView } from "@/views/clientes";
import { ReportesView } from "@/views/reportes";
import { ConfiguracionView } from "@/views/configuracion";
import { ConfigurarBaseDatosView, InfoBaseDatos } from "@/views/configurar-base-datos";
import { reiniciarVentasAbiertas } from "@/hooks/use-ventas-abiertas";
import { ConexionProvider } from "@/hooks/use-conexion";
import { AvisoConexion } from "@/components/aviso-conexion";

const SIDEBAR_STORAGE_KEY = "sidebar-abierto";

function obtenerEstadoSidebarInicial(): boolean {
  const guardado = localStorage.getItem(SIDEBAR_STORAGE_KEY);
  return guardado === null ? true : guardado === "true";
}

export default function App() {
  // Estado que controla qué pantalla está viendo el usuario
  const [vistaActual, setVistaActual] = useState<Vista>("dashboard");

  // Estado abierto/encogido del sidebar, recordado entre reinicios de la app
  const [sidebarAbierto, setSidebarAbierto] = useState(obtenerEstadoSidebarInicial);

  // undefined = todavía verificando, null = falta crearla (primer inicio), objeto = ya configurada
  const [infoDb, setInfoDb] = useState<InfoBaseDatos | null | undefined>(undefined);

  // Al cambiar de sección, volvemos arriba para que la nueva vista no aparezca a mitad de scroll.
  const mainRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [vistaActual]);

  useEffect(() => {
    invoke<InfoBaseDatos | null>("obtener_configuracion_db")
      .then(setInfoDb)
      .catch((err) => {
        console.error("Error al verificar la base de datos:", err);
        setInfoDb(null);
      });
  }, []);

  // Renderizado condicional limpio de las vistas
  const renderVista = () => {
    switch (vistaActual) {
      case "dashboard":
        return <DashboardView onNavegar={setVistaActual} />;
      case "venta":
        return <VentaView />;
      case "catalogo":
        return <CatalogoView />;
      case "inventario":
        return <InventarioView />;
      case "clientes":
        return <ClientesView />;
      case "reportes":
        return <ReportesView />;
      case "configuracion":
        return (
          <ConfiguracionView
            info={infoDb ?? null}
            onBaseEliminada={() => {
              // Las ventas abiertas eran de la base borrada
              reiniciarVentasAbiertas();
              setVistaActual("dashboard");
              setInfoDb(null);
            }}
            onBaseRestaurada={(nuevaInfo) => {
              // Las ventas abiertas se vuelven a leer de la copia restaurada
              reiniciarVentasAbiertas();
              setInfoDb(nuevaInfo);
            }}
          />
        );
      default:
        return <DashboardView onNavegar={setVistaActual} />;
    }
  };

  // Primer inicio: todavía no hay base de datos, pedimos que la creen antes de mostrar la app
  if (infoDb === null) {
    return (
      <>
        <TitleBar className="fixed inset-x-0 top-0 z-50" />
        <ConfigurarBaseDatosView onCreada={setInfoDb} />
      </>
    );
  }

  // Verificando si ya existe una base de datos de un inicio anterior
  if (infoDb === undefined) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <TitleBar className="fixed inset-x-0 top-0 z-50" />
        <p className="text-sm text-muted-foreground">Cargando...</p>
      </div>
    );
  }

  return (
    <ConexionProvider enNube={infoDb.enNube}>
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
    {/* Barra de título propia (reemplaza la de Windows) */}
    <TitleBar />
    <SidebarProvider
      className="min-h-0 flex-1"
      open={sidebarAbierto}
      onOpenChange={(open) => {
        setSidebarAbierto(open);
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(open));
      }}
    >
      <div className="flex h-full w-full overflow-hidden">
        
        {/* Pasamos el estado y la función modificadora al Sidebar */}
        <AppSidebar vistaActual={vistaActual} setVistaActual={setVistaActual} />

        <main className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
          {/* Barra superior común de la aplicación de escritorio */}
          <header className="flex h-14 items-center gap-3 border-b bg-muted/40 px-3 sm:gap-4 sm:px-6 shrink-0">
            <SidebarTrigger />
            <div className="min-w-0 truncate font-medium text-xs text-muted-foreground uppercase tracking-wider">
              Sistema / {vistaActual}
            </div>
            <div className="ml-auto">
              <ModeToggle />
            </div>
          </header>

          <AvisoConexion />

          <div ref={mainRef} className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">

          {/* Área de contenido dinámico. La key fuerza a re-montar el contenedor en cada cambio de
              vista, lo que dispara una entrada suave (fundido + leve desplazamiento). */}
          <div
            key={vistaActual}
            className="p-3 sm:p-6 max-w-screen-2xl w-full mx-auto animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out motion-reduce:animate-none"
          >
            {renderVista()}
          </div>
          </div>
        </main>
      </div>
    </SidebarProvider>
    </div>
    </ConexionProvider>
  );
}
