import { defineConfig, mergeConfig } from "vite";
import desktop from "./vite.config";

// Separate artifact and entry point; the desktop build configuration is unchanged.
export default mergeConfig(desktop, defineConfig({
  build: { outDir: "../.tmp/daemon-web", rollupOptions: { input: "app/daemon.html" } },
}));
