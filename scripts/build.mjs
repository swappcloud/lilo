#!/usr/bin/env node
/**
 * Release-build launcher for the Tauri app.
 *
 * On Windows the Tauri CLI ships as an MSVC binary, and its bundler
 * reconstructs the target triple from its own *compile-time* environment:
 * without `--target` it reports `x86_64-pc-windows-msvc` even when the active
 * Rust toolchain is `windows-gnu`. The bundler then skips the GNU-only
 * packaging step that ships `WebView2Loader.dll`, producing installers whose
 * app cannot start. So detect the active host triple and pass it through; an
 * explicit `--target` from the caller always wins.
 *
 * Usage:  npm run tauri:build [-- --bundles nsis ...]
 */
import { execFileSync, spawn } from "node:child_process";

import { withToolchains } from "./toolchains.mjs";
import { checkVersion } from "./check-version.mjs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { auditBuildOutputs, privacyBuildEnvironment } from "./release-privacy.mjs";

const args = process.argv.slice(2);
const version = checkVersion();
const env = privacyBuildEnvironment(withToolchains(process.env));
// CI prepares the resources (and the frontend) once before its tests and
// sets LILO_PREPARED, so the installer step does not build them again.
if (!args.includes("--help") && !args.includes("-h") && !process.env.LILO_PREPARED) {
  execFileSync(process.execPath, ["scripts/prepare-release.mjs", ...args], { stdio: "inherit", env });
}
const signingKey = join(homedir(), ".config", "lilo", "signing", "updater.key");
if (!env.TAURI_SIGNING_PRIVATE_KEY && existsSync(signingKey)) {
  env.TAURI_SIGNING_PRIVATE_KEY = signingKey;
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
}
const isWindows = process.platform === "win32";
if (process.platform === "linux" && !args.includes("--help") && !args.includes("-h")) {
  const config = join(process.cwd(), ".tmp", "tauri-linux-wake.conf.json");
  if (!existsSync(config)) throw new Error("Linux wake resources have not been prepared.");
  args.push("--config", config);
}

function hostTriple() {
  try {
    const output = execFileSync("rustc", ["-vV"], { encoding: "utf8", env });
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith("host:"));
    return line ? line.slice("host:".length).trim() : "";
  } catch {
    return "";
  }
}

const hasTarget = args.some(
  (arg) => arg === "--target" || arg === "-t" || arg.startsWith("--target=") || arg.startsWith("-t="),
);
const triple = isWindows ? hostTriple() : "";
const target = !hasTarget && triple.endsWith("-windows-gnu") ? ["--target", triple] : [];
if (target.length > 0) {
  console.log(`[build] Windows GNU toolchain detected — bundling with ${triple}`);
}

const child = spawn("npx", ["tauri", "build", ...args, ...target], {
  stdio: "inherit",
  shell: isWindows,
  env,
});

child.on("exit", (code, signal) => {
  if (code !== 0 || signal) process.exit(code || 1);
  if (!args.includes("--help") && !args.includes("-h")) {
    const explicit = args.findIndex((arg) => arg === "--target" || arg === "-t");
    const compact = args.find((arg) => arg.startsWith("--target=") || arg.startsWith("-t="));
    const effectiveTarget = explicit >= 0 ? args[explicit + 1] : compact?.split("=")[1] ?? (triple || hostTriple());
    try {
      auditBuildOutputs(process.cwd(), effectiveTarget, version, env, !hasTarget && !target.length);
      console.log(`[build] Release privacy audit passed for ${effectiveTarget}`);
    } catch (error) {
      console.error(`[build] ${error.message}`);
      process.exit(1);
    }
  }
  process.exit(0);
});
child.on("error", (error) => {
  console.error("[build] failed to start `tauri build`:", error.message);
  process.exit(1);
});
