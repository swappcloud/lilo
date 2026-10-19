import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  configFile: false,
  build: {
    target: "es2022",
    outDir: resolve(process.cwd(), ".tmp/daemon-voice"),
    emptyOutDir: true,
    lib: {
      entry: resolve(process.cwd(), "packages/daemon-browser-host/src/voice_browser.ts"),
      name: "LiloVoice",
      formats: ["iife"],
      fileName: () => "voice.js",
    },
  },
});
