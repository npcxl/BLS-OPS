import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  build: {
    // Keep the initial shell small: the terminal stack is lazy-loaded, and the
    // remaining vendor code is split so app edits don't invalidate it in cache.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@xterm")) return "xterm";
          // The editor is only imported by the lazy FileEditorModal; keeping it
          // out of `vendor` stops ~500 KB of CodeMirror from the first paint.
          if (id.includes("@codemirror") || id.includes("@uiw") || id.includes("codemirror")) {
            return "editor";
          }
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("/react-dom/")) {
            return "react";
          }
          if (id.includes("lucide-react")) return "icons";
          return "vendor";
        },
      },
    },
    // The bundle ships inside the desktop app, so source maps only bloat it.
    sourcemap: false,
  },

  test: {
    environment: "happy-dom",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 4200,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
