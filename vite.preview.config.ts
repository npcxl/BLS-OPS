import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

/** 临时配置：把诊断页构建成可用 file:// 打开的静态页面。 */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: ".tmp-glass-preview",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        preview: `${root}glass-preview.html`,
      },
    },
  },
});
