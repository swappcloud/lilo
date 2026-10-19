#!/usr/bin/env node
/**
 * Publish the installers a release run produced under the version's tag. A
 * target whose build failed has no artifact: the notes list it as missing,
 * and re-running that job adds its installer to the same release.
 *
 * Env: RELEASE_SHA, RELEASE_TAG (the version), GH_TOKEN, GH_REPO.
 * LILO_KEEP_RELEASE_DRAFT=true retains a draft while missing targets are built.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { TARGETS, findRelease } from "./release-plan.mjs";
import { mergeUpdateManifest, updateArtifacts } from "./update-artifacts.mjs";
import { releaseChanges } from "./changelog.mjs";
import { discoverTargetArtifacts, verifyPrivacyReport } from "./release-privacy.mjs";

const sha = process.env.RELEASE_SHA ?? "";
const version = process.env.RELEASE_TAG ?? "";
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid release commit");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version");
const changes = releaseChanges(readFileSync("CHANGELOG.md", "utf8"), version);
const release = findRelease(version);
const releaseSha = /^[a-f0-9]{40}$/.test(release?.targetCommitish ?? "") ? release.targetCommitish : sha;
const root = ".tmp/release-artifacts";
const upload = ".tmp/release-upload";

// Each installer is copied under its published name before upload.
mkdirSync(upload, { recursive: true });
const filesByTarget = discoverTargetArtifacts(root);
const assets = TARGETS.filter(({ target }) => filesByTarget[target]).flatMap(({ target, files: wanted }) => {
  const found = filesByTarget[target];
  return wanted.map(({ suffix, asset }) => {
    const matches = found.filter((path) => path.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected one ${suffix} installer for ${target}`);
    const published = join(upload, asset(version));
    copyFileSync(matches[0], published);
    return published;
  });
});
if (!assets.length) throw new Error("No installer was built");

for (const [target, found] of Object.entries(filesByTarget)) verifyPrivacyReport(found, target, version);
const updates = updateArtifacts(filesByTarget, version, (file) => readFileSync(file, "utf8"));
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
if (release?.assets?.some((asset) => asset.name === "latest.json")) {
  const previous = ".tmp/release-previous";
  mkdirSync(previous, { recursive: true });
  gh(["release", "download", version, "--pattern", "latest.json", "--dir", previous, "--clobber"]);
  updates.manifest = mergeUpdateManifest(JSON.parse(readFileSync(join(previous, "latest.json"), "utf8")), updates.manifest);
}
for (const { source, name } of updates.assets) {
  const path = join(upload, name);
  copyFileSync(source, path);
  if (!assets.includes(path)) assets.push(path);
}
const manifestPath = join(upload, "latest.json");
writeFileSync(manifestPath, JSON.stringify({ ...updates.manifest, notes: changes, pub_date: new Date().toISOString() }, null, 2) + "\n", "utf8");
assets.push(manifestPath);

const names = new Set([...(release?.assets ?? []).map((asset) => asset.name), ...assets.map((path) => path.split(/[\\/]/).pop())]);
const present = TARGETS.filter(({ files: wanted }) => wanted.every(({ asset }) => names.has(asset(version))));
const missing = TARGETS.filter((entry) => !present.includes(entry));

mkdirSync(".tmp", { recursive: true });
writeFileSync(".tmp/release-notes.md", [
  `LILO ${version}, source commit ${releaseSha}.`,
  "",
  changes,
  "",
  "## Which file do I download?",
  "",
  "| Your computer | File |",
  "| --- | --- |",
  ...present.map(({ label, files: wanted }) => `| ${label} | ${wanted.map(({ asset }) => `\`${asset(version)}\``).join(" or ")} |`),
  "",
  "Not sure which Mac you have? Open the Apple menu → About This Mac: \"Chip Apple M…\" means Apple chip, \"Processor … Intel\" means Intel.",
  ...(missing.length
    ? ["", `Not included yet (the build failed; re-run it to add the installer): ${missing.map(({ label }) => label).join("; ")}.`]
    : []),
  "",
  "Windows installers are unsigned. macOS installers use ad-hoc signing without notarization, so the first launch needs right-click → Open.",
  "",
  "This is a prerelease. Installation and account/voice behavior still require testing on each OS.",
].join("\n"), "utf8");

if (!release) {
  gh(["release", "create", version, "--target", sha, "--draft", "--prerelease",
    "--title", `LILO ${version}`, "--notes-file", ".tmp/release-notes.md"]);
}
gh(["release", "upload", version, ...assets, "--clobber"]);
if (process.env.LILO_KEEP_RELEASE_DRAFT !== "true") {
  gh(["release", "edit", version, "--draft=false", "--notes-file", ".tmp/release-notes.md"]);
}
console.log(gh(["release", "view", version, "--json", "url", "--jq", ".url"]));
