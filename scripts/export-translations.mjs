// Export the host's current English keys for third-party language-pack authors.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const cache = new Map();
async function loadModule(filename) {
  if (cache.has(filename)) return cache.get(filename);
  const source = await readFile(filename, "utf8");
  const dependencies = new Map();
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true);
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) throw new Error(`Unexpected external module: ${specifier}`);
    let path = resolve(dirname(filename), specifier);
    if (!extname(path)) path += ".ts";
    dependencies.set(specifier, await loadModule(path));
  }
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require: (name) => {
    if (!dependencies.has(name)) throw new Error(`Unexpected module: ${name}`);
    return dependencies.get(name);
  } }, { filename });
  cache.set(filename, exports);
  return exports;
}

const { EN } = await loadModule(resolve("app/src/i18n/messages/index.ts"));
const messages = Object.fromEntries(Object.entries(EN).sort(([a], [b]) => a.localeCompare(b)));
const outputPath = resolve(process.argv[2] ?? ".tmp/plugin-translations.en.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(messages, null, 2)}\n`, "utf8");
console.log(`Exported ${Object.keys(messages).length} translation keys to ${outputPath}`);
