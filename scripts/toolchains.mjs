import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Setup writes Rust (rustup) and, without MSVC, the portable MinGW toolchain
 * to the *user* PATH. A shell (or editor) started before that still has the
 * old environment, so prepend them: `cargo` needs gcc and windres, and
 * inheriting all three lets `npm run dev` and `tauri:build` work without
 * a restart.
 */
export function withToolchains(env) {
  if (process.platform !== "win32") return env;
  const cargoBin = join(homedir(), ".cargo", "bin");
  const mingwBin = join(env.LOCALAPPDATA ?? "", "lilo", "tools", "w64devkit", "bin");
  const dirs = [
    [cargoBin, "cargo.exe"],
    [mingwBin, "gcc.exe"],
  ]
    .filter(([dir, exe]) => existsSync(join(dir, exe)))
    .map(([dir]) => dir)
    .filter((dir) => !(env.PATH ?? "").toLowerCase().includes(dir.toLowerCase()));
  if (dirs.length === 0) return env;
  return { ...env, PATH: `${dirs.join(";")};${env.PATH ?? ""}` };
}
