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
    // ⚠️ 不要加 rollupOptions.manualChunks（按 node_modules 强拆 vendor/react）。
    // 2026-09 白屏事故：react 块被强拆后与其他 chunk 成环，生产包在模块求值时
    // 抛 "Cannot set properties of undefined (setting 'Activity')"，WebView 白屏，
    // 而 `pnpm tauri dev`（不打包）完全正常——只有安装版能暴露。懒加载分包由
    // 动态 import 边界自然产生（xterm / editor / preview），无需手动干预。
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
