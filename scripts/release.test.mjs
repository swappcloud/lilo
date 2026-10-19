import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { nextVersion, setVersion } from "./bump-version.mjs";
import { TARGETS, decide, releaseVersion, tomlVersion } from "./release-plan.mjs";
import { checkVersion } from "./check-version.mjs";
import { mergeUpdateManifest, updateArtifacts } from "./update-artifacts.mjs";
import { freezeChanges, releaseChanges } from "./changelog.mjs";

test("macOS release builds include the app bundle required for signed updates", () => {
  const macTargets = TARGETS.filter(({ platform }) => platform === "macos");
  assert.equal(macTargets.length, 2);
  for (const { target, bundles } of macTargets) {
    assert.ok(bundles.split(",").includes("app"), `${target} needs an updater app bundle`);
    assert.ok(bundles.split(",").includes("dmg"), `${target} needs a DMG installer`);
  }
});

test("development and release builds validate the actual workspace version", () => {
  const root = new URL("../", import.meta.url);
  const read = (file) => readFileSync(new URL(file, root), "utf8");
  assert.equal(checkVersion(), releaseVersion(read));
});

const manifests = (version, cargo = version) => ({
  "package.json": `{\n  "name": "lilo",\n  "version": "${version}"\n}\n`,
  "src-tauri/tauri.conf.json": `{\n  "productName": "LILO",\n  "version": "${version}"\n}\n`,
  "Cargo.toml": `[workspace]\nmembers = []\n\n[workspace.package]\nversion = "${cargo}"\nedition = "2021"\n`,
  "src-tauri/Cargo.toml": `[package]\nname = "lilo"\nversion = "${version}"\n\n[dependencies]\nserde = { version = "1" }\n`,
});

test("the release version is the one every manifest declares", () => {
  assert.equal(releaseVersion((file) => manifests("0.1.1")[file]), "0.1.1");
  assert.throws(() => releaseVersion((file) => manifests("0.1.1", "0.1.0")[file]), /Cargo.toml=0.1.0/);
  assert.equal(tomlVersion(manifests("0.1.0")["src-tauri/Cargo.toml"], "dependencies"), undefined);
});

test("a version is built once, from one commit", () => {
  assert.equal(decide(null, "a".repeat(40)).build, true);
  assert.equal(decide({ targetCommitish: "a".repeat(40) }, "a".repeat(40)).build, true);
  assert.equal(decide({ targetCommitish: "b".repeat(40) }, "a".repeat(40)).build, false);
});

test("release notes belong to their version and a bump freezes unreleased changes", () => {
  const text = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Stop media helpers.\n\n## [0.1.1]\n\n- Previous changes.\n";
  const frozen = freezeChanges(text, "0.1.2", "2026-10-04");
  assert.equal(releaseChanges(frozen, "0.1.2"), "### Fixed\n\n- Stop media helpers.");
  assert.equal(releaseChanges(frozen, "0.1.1"), "- Previous changes.");
  assert.match(frozen, /## \[Unreleased\]\n\n## \[0\.1\.2\] - 2026-10-04/);
  assert.throws(() => releaseChanges(text, "0.1.2"), /Missing changelog/);
  assert.throws(() => freezeChanges("## [Unreleased]\n", "0.1.2"), /Describe this release/);
  assert.throws(() => freezeChanges(frozen, "0.1.2"), /already contains/);
});

test("updates require a signature and include only the platforms that built", () => {
  const payload = "bundle/LILO_0.1.2_x64-setup.exe";
  const files = { "x86_64-pc-windows-msvc": [payload, `${payload}.sig`] };
  const result = updateArtifacts(files, "0.1.2", () => "c2lnbmF0dXJl");
  assert.deepEqual(Object.keys(result.manifest.platforms), ["windows-x86_64"]);
  assert.equal(result.manifest.platforms["windows-x86_64"].signature, "c2lnbmF0dXJl");
  assert.match(result.manifest.platforms["windows-x86_64"].url, /\/0\.1\.2\/LILO_0\.1\.2_Windows_x64-setup\.exe$/);
  assert.throws(() => updateArtifacts({ "x86_64-pc-windows-msvc": [payload] }, "0.1.2", () => ""), /Missing signature/);
  assert.throws(() => updateArtifacts(files, "0.1.2", () => ""), /Invalid signature/);
});

test("installers are published under names that say which computer they are for", () => {
  const names = TARGETS.flatMap(({ files }) => files.map(({ asset }) => asset("0.1.1")));
  assert.deepEqual(names, [
    "LILO_0.1.1_Windows_x64-setup.exe",
    "LILO_0.1.1_macOS_Apple-Silicon.dmg",
    "LILO_0.1.1_macOS_Intel.dmg",
    "LILO_0.1.1_Linux_x64.deb",
    "LILO_0.1.1_Linux_x64.AppImage",
  ]);
});

test("a platform retry preserves other signed packages and refuses foreign URLs", () => {
  const windows = { signature: "c2ln", url: "https://github.com/swappcloud/lilo/releases/download/0.1.2/LILO_0.1.2_Windows_x64-setup.exe" };
  const linux = { signature: "c2ln", url: "https://github.com/swappcloud/lilo/releases/download/0.1.2/LILO_0.1.2_Linux_x64.AppImage" };
  const prior = { version: "0.1.2", platforms: { "windows-x86_64": windows } };
  const fresh = { version: "0.1.2", platforms: { "linux-x86_64": linux } };
  assert.deepEqual(Object.keys(mergeUpdateManifest(prior, fresh).platforms), ["windows-x86_64", "linux-x86_64"]);
  assert.throws(() => mergeUpdateManifest(prior, { ...fresh, version: "0.1.3" }), /different update versions/);
  assert.throws(() => mergeUpdateManifest({ ...prior, platforms: { "windows-x86_64": { ...windows, url: "https://example.com/app.exe" } } }, fresh), /Invalid published/);
});

test("a bump moves every manifest and nothing else", () => {
  assert.equal(nextVersion("0.1.9", "patch"), "0.1.10");
  assert.equal(nextVersion("0.1.9", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.9", "major"), "1.0.0");
  assert.throws(() => nextVersion("0.1.9", "next"));
  const files = manifests("0.1.0");
  const bumped = Object.fromEntries(Object.entries(files).map(([file, text]) => [file, setVersion(file, text, "0.1.0", "0.1.1")]));
  assert.equal(releaseVersion((file) => bumped[file]), "0.1.1");
  assert.match(bumped["src-tauri/Cargo.toml"], /serde = \{ version = "1" \}/);
  const lock = `{\n  "version": "0.1.0",\n  "packages": {\n    "": {\n      "version": "0.1.0"\n    },\n    "node_modules/x": {\n      "version": "0.1.0"\n    }\n  }\n}\n`;
  assert.equal(setVersion("package-lock.json", lock, "0.1.0", "0.1.1").match(/0\.1\.1/g)?.length, 2);
});
