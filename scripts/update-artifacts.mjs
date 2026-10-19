/** Signed Tauri v2 artifacts published beside the desktop installers. */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const UPDATE_TARGETS = [
  { target: "x86_64-pc-windows-msvc", platform: "windows-x86_64", suffix: "_x64-setup.exe", asset: (v) => `LILO_${v}_Windows_x64-setup.exe` },
  { target: "aarch64-apple-darwin", platform: "darwin-aarch64", suffix: ".app.tar.gz", asset: (v) => `LILO_${v}_macOS_Apple-Silicon.app.tar.gz` },
  { target: "x86_64-apple-darwin", platform: "darwin-x86_64", suffix: ".app.tar.gz", asset: (v) => `LILO_${v}_macOS_Intel.app.tar.gz` },
  { target: "x86_64-unknown-linux-gnu", platform: "linux-x86_64", suffix: "_amd64.AppImage", asset: (v) => `LILO_${v}_Linux_x64.AppImage` },
];

export function updateArtifacts(filesByTarget, version, read, repository = "swappcloud/lilo") {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid update version");
  if (repository !== "swappcloud/lilo") throw new Error("Unexpected update repository");
  const platforms = {};
  const assets = [];
  for (const target of UPDATE_TARGETS) {
    const files = filesByTarget[target.target];
    if (!files) continue;
    const payloads = files.filter((file) => file.endsWith(target.suffix));
    if (payloads.length !== 1) throw new Error(`Expected one update artifact for ${target.target}`);
    const source = payloads[0];
    const signatureFile = `${source}.sig`;
    if (!files.includes(signatureFile)) throw new Error(`Missing signature for ${target.target}`);
    const signature = read(signatureFile).trim();
    if (!signature || !/^[A-Za-z0-9+/=\s]+$/.test(signature)) throw new Error(`Invalid signature for ${target.target}`);
    const name = target.asset(version);
    assets.push({ source, name }, { source: signatureFile, name: `${name}.sig` });
    platforms[target.platform] = { signature, url: `https://github.com/${repository}/releases/download/${version}/${name}` };
  }
  return { assets, manifest: { version, platforms } };
}

/** A platform retry must preserve packages already published for this version. */
export function mergeUpdateManifest(previous, current) {
  if (previous.version !== current.version) throw new Error("Cannot merge different update versions");
  const platforms = { ...previous.platforms, ...current.platforms };
  for (const [platform, entry] of Object.entries(platforms)) {
    const target = UPDATE_TARGETS.find((target) => target.platform === platform);
    const expected = target && `https://github.com/swappcloud/lilo/releases/download/${current.version}/${target.asset(current.version)}`;
    if (!expected || entry?.url !== expected || !entry.signature || !/^[A-Za-z0-9+/=\s]+$/.test(entry.signature)) {
      throw new Error(`Invalid published update platform: ${platform}`);
    }
  }
  return { ...previous, ...current, platforms };
}

// Check the built payload before uploading artifacts or starting publication.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [target, version, root] = process.argv.slice(2);
  if (!target || !version || !root || process.argv.length !== 5) {
    throw new Error("Usage: node scripts/update-artifacts.mjs <target> <version> <bundle-directory>");
  }
  if (!UPDATE_TARGETS.some((entry) => entry.target === target)) throw new Error("Unknown update target");
  function files(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
    });
  }
  updateArtifacts({ [target]: files(root) }, version, (file) => readFileSync(file, "utf8"));
  console.log(`Validated signed updater artifacts for ${target}`);
}
