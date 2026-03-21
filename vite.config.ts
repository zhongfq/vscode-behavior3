import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "webview",
  base: "./",
  publicDir: path.resolve(__dirname, "public"),
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "webview/shared"),
      "@behavior3": path.resolve(__dirname, "behavior3/src/behavior3"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/webview"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        editor: path.resolve(__dirname, "webview/editor/index.html"),
        inspector: path.resolve(__dirname, "webview/inspector/index.html"),
      },
    },
    sourcemap: true,
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: "modern",
      },
    },
  },
});
