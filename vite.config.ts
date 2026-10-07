import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri expects a fixed dev port and serves the built files from ../dist.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // WebView2 (Chromium) on Windows/Linux, WKWebView (Safari) on macOS.
    target: ["chrome120", "safari16"],
    cssTarget: ["chrome120", "safari16"],
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
