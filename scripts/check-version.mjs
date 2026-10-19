import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { releaseVersion } from "./release-plan.mjs";

/** Development and installers use the same version committed locally. */
export function checkVersion() {
  const root = new URL("../", import.meta.url);
  return releaseVersion((file) => readFileSync(new URL(file, root), "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(checkVersion());
}
