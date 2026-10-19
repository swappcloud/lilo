#!/usr/bin/env node
/**
 * Set the app version everywhere it is declared, so the next scheduled run
 * can publish it as a release (scripts/nightly-release.mjs).
 *
 *   npm run version:bump -- patch      # 0.1.0 -> 0.1.1
 *   npm run version:bump -- minor      # 0.1.1 -> 0.2.0
 *   npm run version:bump -- 1.0.0
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { releaseVersion } from "./release-plan.mjs";
import { freezeChanges } from "./changelog.mjs";

export function nextVersion(current, request) {
  if (/^\d+\.\d+\.\d+$/.test(request)) return request;
  const [major, minor, patch] = current.split(".").map(Number);
  if (request === "patch") return `${major}.${minor}.${patch + 1}`;
  if (request === "minor") return `${major}.${minor + 1}.0`;
  if (request === "major") return `${major + 1}.0.0`;
  throw new Error(`Use patch, minor, major or x.y.z, not "${request}"`);
}

/**
 * Text edits, so each file keeps its formatting: the JSON files' version
 * fields (package-lock.json carries it twice, at the top and for the root
 * package) and the `version = ` line of the TOML section.
 */
export function setVersion(file, text, from, to) {
  if (file.endsWith(".json")) {
    const field = `"version": "${from}"`;
    const times = file === "package-lock.json" ? 2 : 1;
    let out = text;
    for (let i = 0; i < times; i++) {
      if (!out.includes(field)) throw new Error(`${file}: no version ${from}`);
      out = out.replace(field, `"version": "${to}"`);
    }
    return out;
  }
  const pattern = new RegExp(`^(version\\s*=\\s*)"${from.replace(/\./g, "\\.")}"`, "m");
  if (!pattern.test(text)) throw new Error(`${file}: no version ${from}`);
  return text.replace(pattern, `$1"${to}"`);
}

const FILES = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "Cargo.toml", "src-tauri/Cargo.toml"];

function bump(request) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const read = (file) => readFileSync(root + file, "utf8");
  const from = releaseVersion(read);
  const to = nextVersion(from, request ?? "");
  if (to === from) throw new Error(`Already at ${from}`);
  const changelog = freezeChanges(read("CHANGELOG.md"), to);
  for (const file of FILES) writeFileSync(root + file, setVersion(file, read(file), from, to), "utf8");
  writeFileSync(root + "CHANGELOG.md", changelog, "utf8");
  // Cargo.lock records the workspace crates' versions; cargo rewrites them.
  try {
    execFileSync("cargo", ["update", "--workspace", "--offline"], { cwd: root, stdio: "inherit" });
  } catch {
    console.log("Run `cargo update --workspace` to refresh Cargo.lock before committing.");
  }
  console.log(`${from} -> ${to}. Commit and push to main for the next scheduled release of ${to}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) bump(process.argv[2]);
