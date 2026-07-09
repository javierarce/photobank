import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  // Pre-bundle the Tauri plugins the app loads via dynamic import(). Without
  // this, the first runtime import of a not-yet-optimized plugin makes Vite
  // re-optimize and hard-reload the page mid-action.
  optimizeDeps: {
    include: [
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/api/window",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-updater",
      "@tauri-apps/plugin-process",
    ],
  },
  server: {
    // Tauri's devUrl is hardcoded to :5173. Fail loudly if it's taken (e.g. a
    // stale dev server from another checkout) instead of silently falling back
    // to another port — otherwise the Tauri window loads the wrong app.
    port: 5173,
    strictPort: true,
  },
})
