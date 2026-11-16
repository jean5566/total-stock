import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "@/components/theme-provider";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./index.css"

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);

// La ventana arranca oculta (ver "visible": false en tauri.conf.json). La mostramos cuando el
// navegador ya pintó el primer frame con el tema aplicado, así no se ve el destello blanco.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    getCurrentWindow().show().catch(() => {});
  });
});
