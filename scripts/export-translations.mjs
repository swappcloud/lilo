// Export the host's current English keys for third-party language-pack authors.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import vm from "node:vm";
import { build } from "vite";

// Bundle the local dictionaries through Vite's public API. TypeScript 7 no
// longer exposes the legacy JavaScript compiler API used by this exporter.
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    lib: { entry: resolve("app/src/i18n/messages/index.ts"), formats: ["cjs"] },
  },
});
const output = (Array.isArray(bundle) ? bundle[0] : bundle).output;
const chunk = output.find((entry) => entry.type === "chunk" && entry.isEntry);
if (!chunk) throw new Error("Translation bundle has no entry");
const exports = {};
vm.runInNewContext(chunk.code, { exports, module: { exports } });
const { EN } = exports;
const messages = Object.fromEntries(Object.entries(EN).sort(([a], [b]) => a.localeCompare(b)));
const outputPath = resolve(process.argv[2] ?? ".tmp/plugin-translations.en.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(messages, null, 2)}\n`, "utf8");
console.log(`Exported ${Object.keys(messages).length} translation keys to ${outputPath}`);
