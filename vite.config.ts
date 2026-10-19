import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: ["chrome120", "safari16"],
    cssTarget: ["chrome120", "safari16"],
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
