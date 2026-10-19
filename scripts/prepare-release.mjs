#!/usr/bin/env node
/** Prepare native resources without embedding a developer's signing identity. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareLinuxWake } from "./prepare-linux-wake.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node scripts/prepare-release.mjs [--target <Rust target>]");
  process.exit(0);
}
const targetIndex = args.indexOf("--target");
const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
if (targetIndex >= 0 && !target) throw new Error("--target requires a Rust target.");
if (process.platform === "darwin") {
  const architecture = target?.startsWith("x86_64-") ? "x86_64"
    : target?.startsWith("aarch64-") ? "arm64" : process.arch === "arm64" ? "arm64" : "x86_64";
  if (target && !["aarch64-apple-darwin", "x86_64-apple-darwin"].includes(target)) {
    throw new Error("Build macOS releases for aarch64-apple-darwin or x86_64-apple-darwin.");
  }
  execFileSync("sh", ["scripts/build-wake.sh"], {
    cwd: root, stdio: "inherit",
    env: { ...process.env, LILO_SIGN_IDENTITY: "-", LILO_WAKE_TARGET: `${architecture}-apple-macos12` },
  });
}
if (process.platform === "linux") prepareLinuxWake(root);
