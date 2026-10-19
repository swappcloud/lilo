import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptTests = readdirSync(join(root, "scripts"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join(root, "scripts", name));
const suites = [
  [join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", join(root, "packages", "daemon-browser-host", "vite.voice.config.mjs")],
  [join(root, "node_modules", "vitest", "vitest.mjs"), "run"],
  ["--test", ...scriptTests, join(root, "packages", "daemon-browser-host", "test", "voice_service.test.mjs")],
];

for (const args of suites) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
