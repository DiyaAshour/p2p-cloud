import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "client", "src"),
      "@assets": path.resolve(process.cwd(), "attached_assets"),
    },
  },
  root: path.resolve(process.cwd(), "client"),
  publicDir: path.resolve(process.cwd(), "client", "public"),
  build: {
    outDir: path.resolve(process.cwd(), "dist/public"),
    emptyOutDir: true,
    modulePreload: {
      polyfill: false,
    },
  },
  server: {
    host: "127.0.0.1",
  },
});
