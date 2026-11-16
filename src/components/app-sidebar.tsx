import { BarChart3, Boxes, LayoutDashboard, Package, Settings, ShoppingCart, Users } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { NOMBRE_APP, useVersionApp } from "@/hooks/use-info-app";

// Definimos los tipos de vistas disponibles en nuestra app
export type Vista = "dashboard" | "venta" | "catalogo" | "inventario" | "clientes" | "reportes" | "configuracion";

interface AppSidebarProps {
  vistaActual: Vista;
  setVistaActual: (vista: Vista) => void;
}

// Estructura del sidebar organizada por secciones
interface SidebarItem {
  id: Vista;
  title: string;
  icon: typeof LayoutDashboard;
}

interface SidebarSection {
  label: string;
  items: SidebarItem[];
}

const sections: SidebarSection[] = [
  {
    label: "General",
    items: [
      { id: "dashboard", title: "Panel Principal", icon: LayoutDashboard },
      { id: "venta", title: "Venta", icon: ShoppingCart },
    ],
  },
  {
    label: "Gestión",
    items: [
      { id: "catalogo", title: "Catálogo", icon: Package },
      { id: "inventario", title: "Inventario", icon: Boxes },
      { id: "clientes", title: "Clientes", icon: Users },
    ],
  },
  {
    label: "Análisis",
    items: [
      { id: "reportes", title: "Reportes", icon: BarChart3 },
    ],
  },
  {
    label: "Sistema",
    items: [
      { id: "configuracion", title: "Configuración", icon: Settings },
    ],
  },
];

export function AppSidebar({ vistaActual, setVistaActual }: AppSidebarProps) {
  const version = useVersionApp();
  return (
    <Sidebar
      variant="sidebar"
      collapsible="icon"
      // Empieza debajo de la barra de título propia (h-9) en vez de en el borde de la ventana
      className="top-9! h-[calc(100svh-2.25rem)]!"
    >
      <SidebarContent>
        {sections.map((section, index) => (
          <SidebarGroup key={section.label}>
            {index > 0 && (
              <SidebarSeparator className="mb-2 transition-opacity duration-200 group-data-[collapsible=icon]:opacity-0" />
            )}
            <SidebarGroupLabel className="whitespace-nowrap">
              {section.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1 group-data-[collapsible=icon]:gap-2">
                {section.items.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      onClick={() => setVistaActual(item.id)}
                      isActive={vistaActual === item.id}
                      tooltip={item.title}
                    >
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      {/* Se desvanece en vez de aparecer de golpe, y no se parte en varias líneas mientras el
          menú todavía se está abriendo */}
      <SidebarFooter className="overflow-hidden border-t border-sidebar-border px-4 py-3 transition-opacity duration-200 group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0">
        <p className="whitespace-nowrap text-[11px] leading-tight text-sidebar-foreground/70">
          {NOMBRE_APP}
          {version && ` v${version}`}
        </p>
      </SidebarFooter>
    </Sidebar>
  );
}
