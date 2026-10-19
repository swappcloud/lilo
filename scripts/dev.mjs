#!/usr/bin/env node
/**
 * Dev launcher for the Tauri app.
 *
 * Problems this solves:
 *   - "Port 1420 is already in use" after an earlier dev session left Vite (or
 *     the Tauri CLI) running.
 *   - Leftover processes after closing the app / Ctrl+C.
 *
 * Behaviour:
 *   - Preflight: free the dev ports (Vite 1420, HMR 1421, Tauri static 1430).
 *   - Start `tauri dev` in the foreground.
 *   - On exit or signal: free the ports again so nothing lingers.
 *
 * Usage:
 *   npm run dev              # normal dev run
 *   npm run dev -- --no-watch
 *   npm run dev:free         # only free the ports and exit
 */
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";

import { withToolchains } from "./toolchains.mjs";
import { checkVersion } from "./check-version.mjs";

const PORTS = [1420, 1421, 1430];
const isWindows = process.platform === "win32";

function runQuiet(command) {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return "";
  }
}

function pidsOnPort(port) {
  if (isWindows) {
    const output = runQuiet(`netstat -ano -p tcp | findstr :${port}`);
    return [
      ...new Set(
        output
          .split(/\r?\n/)
          .map((line) => line.trim().split(/\s+/))
          .filter((parts) => parts.length >= 5 && parts[1]?.endsWith(`:${port}`))
          .map((parts) => parts[4])
          .filter(Boolean),
      ),
    ];
  }
  return runQuiet(`lsof -ti tcp:${port}`).split(/\s+/).filter(Boolean);
}

function killPids(pids) {
  for (const pid of pids) {
    runQuiet(isWindows ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`);
  }
}

function freePorts(label) {
  for (const port of PORTS) {
    const pids = pidsOnPort(port);
    if (pids.length === 0) continue;
    console.log(`[dev] ${label}: freeing port ${port} → pids ${pids.join(", ")}`);
    killPids(pids);
  }
}

/**
 * Build the macOS wake-word helper when it is missing or out of date.
 *
 * The bundle is not committed: signing stamps whoever built it into the binary,
 * and that identity does not belong in the repository. So every machine builds
 * and signs its own, and dev has to do it rather than leaving the wake word
 * quietly broken on a fresh clone.
 */
function buildWakeHelper() {
  if (process.platform !== "darwin") return;
  const binary = "src-tauri/binaries/LiloWake.app/Contents/MacOS/lilo-wake";
  const source = "src-tauri/wake/lilo-wake.swift";
  const built = statSync(binary, { throwIfNoEntry: false });
  if (built && built.mtimeMs >= statSync(source).mtimeMs) return;
  console.log(`[dev] building the wake helper (${built ? "source changed" : "not built yet"})`);
  try {
    execFileSync("./scripts/build-wake.sh", { stdio: "inherit" });
  } catch {
    console.error("[dev] wake helper build failed — the wake word will not work");
  }
}

/** Install locked JavaScript dependencies on a fresh checkout before `npx`. */
function ensureNpmDependencies() {
  const check = spawnSync("npm", ["ls", "@tauri-apps/cli", "--depth=0"], {
    stdio: "ignore",
    shell: isWindows,
  });
  if (!check.error && check.status === 0) return;

  console.log("[dev] npm dependencies are missing; installing from package-lock.json");
  const install = spawnSync("npm", ["ci"], {
    stdio: "inherit",
    shell: isWindows,
  });
  if (install.error || install.status !== 0) {
    if (install.error) console.error(`[dev] could not start npm: ${install.error.message}`);
    console.error("[dev] dependency setup failed. Run `npm run setup`, then retry `npm run dev`.");
    process.exit(install.status && install.status > 0 ? install.status : 1);
  }
}

const args = process.argv.slice(2);

if (args.includes("--free-only")) {
  freePorts("free-only");
  console.log("[dev] ports are free");
  process.exit(0);
}

checkVersion();
freePorts("preflight");
ensureNpmDependencies();
buildWakeHelper();

const child = spawn("npx", ["tauri", "dev", ...args], {
  stdio: "inherit",
  shell: isWindows,
  env: withToolchains(process.env),
});

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  freePorts("shutdown");
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  });
}

child.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("[dev] failed to start `tauri dev`:", error.message);
  cleanup();
  process.exit(1);
});
