import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // The web app lives in its own folder; the repo root stays for the Rust
  // workspace, the docs and the scripts. `dist/` still lands at the root,
  // which is what `frontendDist` in tauri.conf.json points at.
  root: "app",
  publicDir: "app/public",
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      },
    }),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      output: {
        // Dependencies change far less often than the app: their own chunk
        // keeps each under the size budget and cached across app updates.
        manualChunks: (id) => (id.includes("/node_modules/") ? "vendor" : undefined),
      },
    },
  },
});
