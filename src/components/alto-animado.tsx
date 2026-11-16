import { useLayoutEffect, useRef, useState } from "react";

// Contenedor que anima su altura cuando cambia el contenido (p. ej. una tabla que pasa de 20 filas
// a 3 al aplicar un filtro), en vez de encogerse o crecer de golpe.
export function AltoAnimado({ children }: { children: React.ReactNode }) {
  const interior = useRef<HTMLDivElement>(null);
  const [alto, setAlto] = useState<number>();

  useLayoutEffect(() => {
    const el = interior.current;
    if (!el) return;
    const observador = new ResizeObserver(() => setAlto(el.offsetHeight));
    observador.observe(el);
    return () => observador.disconnect();
  }, []);

  return (
    <div
      style={{ height: alto }}
      className="overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none"
    >
      <div ref={interior}>{children}</div>
    </div>
  );
}
