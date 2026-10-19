// Build the catalog from plugin manifests and locally computed SHA-256 digests.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "examples/plugins");
const plugins = [];

async function filesIn(directory, prefix = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relative === "data" || relative === "settings.json" || relative === ".disabled") continue;
    if (entry.isDirectory()) files.push(...await filesIn(join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

const directories = await readdir(root, { withFileTypes: true });
for (const name of directories.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
  const directory = join(root, name);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, "plugin.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  const files = [];
  for (const path of await filesIn(directory)) {
    const bytes = await readFile(join(directory, path));
    files.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  plugins.push({
    id: manifest.id,
    name: manifest.name || manifest.id,
    description: manifest.description ?? "",
    localized: manifest.localized ?? {},
    version: manifest.version,
    api: manifest.api,
    capabilities: manifest.capabilities ?? [],
    ...(manifest.hosts !== undefined ? { hosts: manifest.hosts } : {}),
    ...(manifest.platforms?.length ? { platforms: manifest.platforms } : {}),
    path: name,
    entry: manifest.entry,
    files,
  });
}

await writeFile(join(root, "index.json"), `${JSON.stringify({ plugins }, null, 2)}\n`, "utf8");
console.log(`Marketplace index written to ${join(root, "index.json")}`);
