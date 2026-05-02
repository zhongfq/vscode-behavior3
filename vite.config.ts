import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  root: "webview",
  base: "./",
  publicDir: path.resolve(__dirname, "public"),
  build: {
    outDir: path.resolve(__dirname, "dist/webview"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        v2: path.resolve(__dirname, "webview/v2/index.html"),
      },
    },
    // dev mode: inline sourcemaps (CSP-safe, no separate .map files)
    // production: no sourcemaps to keep bundle size small
    sourcemap: mode === "development" ? "inline" : false,
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: "modern",
      },
    },
  },
}));
