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
const explicit = args.findIndex((arg) => arg === "--target" || arg === "-t");
const compact = args.find((arg) => arg.startsWith("--target=") || arg.startsWith("-t="));
const requestedTarget = explicit >= 0 ? args[explicit + 1] : compact?.split("=")[1] ?? "";
const env = privacyBuildEnvironment(withToolchains(process.env), undefined, undefined, process.platform, requestedTarget);
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

const command = ["tauri", "build", ...args, ...target];
const isMacDmgBuild = process.platform === "darwin" && args.some((arg, index) =>
  ((arg === "--bundles" || arg === "-b") && args[index + 1]?.split(",").includes("dmg")) ||
  (arg.startsWith("--bundles=") && arg.slice("--bundles=".length).split(",").includes("dmg")));

function run(attempt = 1) {
  let output = "";
  const child = spawn("npx", command, { stdio: ["inherit", "pipe", "pipe"], shell: isWindows, env });
  child.stdout.on("data", (chunk) => { process.stdout.write(chunk); output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { process.stderr.write(chunk); output += chunk.toString(); });

  child.on("exit", (code, signal) => {
    const transientDmgError = /hdiutil[^\n]*resource busy|couldn't eject[^\n]*resource busy|resource busy/i.test(output);
    if ((code !== 0 || signal) && isMacDmgBuild && attempt < 3 && transientDmgError) {
      console.warn(`[build] Transient macOS DMG mount error; retrying bundle (${attempt + 1}/3)`);
      run(attempt + 1);
      return;
    }
    if (code !== 0 || signal) process.exit(code || 1);
    if (!args.includes("--help") && !args.includes("-h")) {
      const effectiveTarget = requestedTarget || triple || hostTriple();
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
}

run();
