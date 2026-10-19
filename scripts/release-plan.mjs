#!/usr/bin/env node
/**
 * Shared release targets, manifest versions and published-release lookup.
 * Daily changed-main planning lives in nightly-release.mjs.
 * This version-specific planner performs read-only release inspection and
 * writes build, tag and matrix to GITHUB_OUTPUT when explicitly invoked.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Tauri names bundles `LILO_<version>_<arch>...`; `suffix` finds a target's
 * file and `asset` is the name it is published under, which says plainly
 * which computer it is for.
 */
export const TARGETS = [
  { platform: "windows", os: "windows-2022", target: "x86_64-pc-windows-msvc", bundles: "nsis",
    label: "Windows 10/11 (64-bit)",
    files: [{ suffix: "_x64-setup.exe", asset: (v) => `LILO_${v}_Windows_x64-setup.exe` }] },
  { platform: "macos", os: "macos-15", target: "aarch64-apple-darwin", bundles: "app,dmg",
    label: "Mac with an Apple chip (M1, M2, M3, M4 and later)",
    files: [{ suffix: "_aarch64.dmg", asset: (v) => `LILO_${v}_macOS_Apple-Silicon.dmg` }] },
  { platform: "macos", os: "macos-15-intel", target: "x86_64-apple-darwin", bundles: "app,dmg",
    label: "Mac with an Intel processor",
    files: [{ suffix: "_x64.dmg", asset: (v) => `LILO_${v}_macOS_Intel.dmg` }] },
  { platform: "linux", os: "ubuntu-22.04", target: "x86_64-unknown-linux-gnu", bundles: "deb,appimage",
    label: "Linux x64 (.deb for Debian/Ubuntu, .AppImage for other distributions)",
    files: [
      { suffix: "_amd64.deb", asset: (v) => `LILO_${v}_Linux_x64.deb` },
      { suffix: "_amd64.AppImage", asset: (v) => `LILO_${v}_Linux_x64.AppImage` },
    ] },
];

/** Where the version is declared; every one must agree. */
export const MANIFESTS = {
  "package.json": (text) => JSON.parse(text).version,
  "src-tauri/tauri.conf.json": (text) => JSON.parse(text).version,
  "Cargo.toml": (text) => tomlVersion(text, "workspace.package"),
  "src-tauri/Cargo.toml": (text) => tomlVersion(text, "package"),
};

/** `version = "…"` inside `[section]`, without a TOML parser. */
export function tomlVersion(text, section) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("[")) return undefined;
    const match = /^\s*version\s*=\s*"([^"]+)"/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** The one version all manifests declare, or an error naming the odd one out. */
export function releaseVersion(read) {
  const found = Object.entries(MANIFESTS).map(([file, parse]) => [file, parse(read(file))]);
  const versions = new Set(found.map(([, version]) => version));
  if (versions.size !== 1) {
    throw new Error(`Versions disagree: ${found.map(([file, version]) => `${file}=${version}`).join(", ")}. Run npm run version:bump.`);
  }
  const [version] = versions;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`Not a release version: ${version}`);
  return version;
}

/** Build when the version has no release yet, or when its release is this commit's (a re-run). */
export function decide(release, sha) {
  if (!release) return { build: true, reason: "first build of this version" };
  if (release.targetCommitish === sha) return { build: true, reason: "re-run for the commit this version was released from" };
  return { build: false, reason: `already released from ${release.targetCommitish.slice(0, 12)}; run npm run version:bump to release this commit` };
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function findRelease(tag) {
  try {
    return JSON.parse(gh(["release", "view", tag, "--json", "targetCommitish,isDraft,assets"]));
  } catch (error) {
    if (String(error.stderr).includes("release not found")) return null;
    throw error;
  }
}

function plan() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const version = releaseVersion((file) => readFileSync(root + file, "utf8"));
  const sha = process.env.RELEASE_SHA ?? "";
  const { build, reason } = decide(findRelease(version), sha);
  // A notice, not a warning: skipping an unchanged version is the normal case.
  console.log(`${build ? "" : "::notice::"}Release ${version}: ${build ? "building" : "nothing to build"} (${reason})`);
  const matrix = TARGETS.map(({ platform, os, target, bundles }) => ({ platform, os, target, bundles }));
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `build=${build}\ntag=${version}\nmatrix=${JSON.stringify(matrix)}\n`, "utf8");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) plan();
