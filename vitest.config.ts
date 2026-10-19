import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["app/src/testSetup.ts"],
    include: ["app/src/**/*.test.ts", "app/src/**/*.test.tsx"],
    // Node >= 22's own global `localStorage` shadows jsdom's when both are
    // defined; disabling Node's (unused here, unbacked by --localstorage-file
    // anyway) lets jsdom's real implementation win.
  execArgv: ["--no-experimental-webstorage"],
  },
});
