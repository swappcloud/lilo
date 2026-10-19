import assert from "node:assert/strict";
import { test } from "node:test";
import { nightlyPlan, prepareNightlyVersion } from "./nightly-release.mjs";
import { TARGETS, releaseVersion } from "./release-plan.mjs";
import { privacyBuildEnvironment } from "./release-privacy.mjs";
import { UPDATE_TARGETS } from "./update-artifacts.mjs";

const sha = "a".repeat(40);
test("release builds cannot inherit a personal Apple signing or notarization identity", () => {
  const original = { APPLE_SIGNING_IDENTITY: "Developer certificate", APPLE_ID: "private-account", APPLE_API_KEY_PATH: "private-key", APPLE_CERTIFICATE: "certificate", TAURI_SIGNING_PRIVATE_KEY: "updater-key" };
  const env = privacyBuildEnvironment(original, "/synthetic/toolchain", "/synthetic/project");
  assert.equal(env.APPLE_SIGNING_IDENTITY, "-");
  assert.equal(env.LILO_SIGN_IDENTITY, "-");
  assert.equal(env.APPLE_ID, undefined);
  assert.equal(env.APPLE_API_KEY_PATH, undefined);
  assert.equal(env.APPLE_CERTIFICATE, undefined);
  assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, "updater-key");
  assert.equal(original.APPLE_ID, "private-account");
});
const release = (tag = "0.1.3") => ({ tag_name: tag, target_commitish: sha, draft: false,
  assets: [{ name: "latest.json" }, ...TARGETS.flatMap((t) => t.files.map((f) => ({ name: f.asset(tag) }))),
    ...UPDATE_TARGETS.flatMap((t) => [{name:t.asset(tag)}, {name:t.asset(tag)+".sig"}])],
});
test("daily planning skips a fully published unchanged main", () => {
  assert.equal(nightlyPlan("0.1.3", sha, [release()]).build, false);
  assert.equal(nightlyPlan("0.1.3", sha, []).build, true);
});
test("unpublished changes receive a new immutable version even without a manual bump", () => {
  assert.equal(nightlyPlan("0.1.3", "b".repeat(40), [release()]).tag, "0.1.4");
  assert.equal(nightlyPlan("0.2.0", "b".repeat(40), [release()]).tag, "0.2.0");
  assert.equal(nightlyPlan("0.1.3", "b".repeat(40), [release("0.1.10"), release("0.1.9")]).tag, "0.1.11");
});
test("failed or partial publication retries the same version instead of skipping missing platforms", () => {
  for (const entry of [{ ...release(), draft: true }, { ...release(), assets: [] }, { ...release(), assets: release().assets.slice(0, -1) }]) {
    const plan = nightlyPlan("0.1.3", sha, [entry]);
    assert.equal(plan.build, true);
    assert.equal(plan.tag, "0.1.3");
    assert.equal(plan.reason, "finish an incomplete release");
    assert.ok(plan.targets.length > 0);
  }
  assert.throws(() => nightlyPlan("0.1.3", "main", []), /Invalid/);
});
test("a later main commit resumes only missing targets of an incomplete release", () => {
  const partial = { ...release("0.1.0"), target_commitish: "c".repeat(40) };
  partial.assets = partial.assets.filter((asset) =>
    !asset.name.includes("Windows") && !asset.name.includes("windows-x86_64"));
  const plan = nightlyPlan("0.1.0", "b".repeat(40), [partial]);
  assert.equal(plan.tag, "0.1.0");
  assert.deepEqual(plan.targets.map((target) => target.target), ["x86_64-pc-windows-msvc"]);
});
test("a disposable checkout gets matching versions and valid notes without touching lockfiles", () => {
  const files = {
    "package.json": '{"version": "0.1.3"}',
    "src-tauri/tauri.conf.json": '{"version": "0.1.3"}',
    "Cargo.toml": '[workspace.package]\nversion = "0.1.3"\n',
    "src-tauri/Cargo.toml": '[package]\nversion = "0.1.3"\n',
    "CHANGELOG.md": '## [Unreleased]\n\n## [0.1.3]\n\n- Previous changes.\n',
  };
  const writes = [];
  prepareNightlyVersion("0.1.4", (file) => files[file], (file, text) => { writes.push(file); files[file] = text; });
  assert.equal(releaseVersion((file) => files[file]), "0.1.4");
  assert.match(files["CHANGELOG.md"], /## \[0\.1\.4\]/);
  assert.equal(writes.some((file) => file.endsWith(".lock") || file.includes("lock.json")), false);
});
test("workflow publishes on main, supports scheduled and manual retries", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../.github/workflows/release-build.yml", import.meta.url), "utf8");
  assert.match(workflow, /schedule:\s*\n\s*- cron: '0 2 \* \* \*'/);
  assert.match(workflow, /^\s*workflow_dispatch:/m);
  assert.match(workflow, /^\s*push:\s*\n\s*branches: \[main\]/m);
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.match(workflow, /node scripts\/nightly-release\.mjs/);
  assert.doesNotMatch(workflow, /node scripts\/release-test\.mjs/);
  assert.doesNotMatch(workflow, /run: npm test/);
  assert.doesNotMatch(workflow, /run: npm run typecheck/);
  assert.doesNotMatch(workflow, /run: cargo test --workspace\s*$/m);
  assert.match(workflow, /build:\s*\n\s*needs: \[plan, frontend\]/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /needs\.frontend\.result == 'success' && \(needs\.build\.result == 'success' \|\| needs\.build\.result == 'failure'\)/);
  assert.match(workflow, /Check updater signing configuration/);
});

test("PR CI covers app checks, workspace tests, and the Windows release profile", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /^\s*pull_request:\s*\n\s*branches: \[main\]/m);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /cargo test --workspace/);
  assert.match(workflow, /node scripts\/release-test\.mjs x86_64-pc-windows-msvc/);
  assert.match(workflow, /node --test scripts\/release-privacy\.test\.mjs/);
  assert.match(workflow, /runs-on: macos-15-intel/);
  assert.match(workflow, /node scripts\/release-test\.mjs x86_64-apple-darwin/);
});

test("MSVC linker manifest path resolves from the workspace root", async () => {
  const { readFile } = await import("node:fs/promises");
  const build = await readFile(new URL("../src-tauri/build.rs", import.meta.url), "utf8");
  assert.match(build, /Path::new\("src-tauri\/windows"\)\.join\("app-manifest\.xml"\)/);
  assert.match(build, /Path::new\(env!\("CARGO_MANIFEST_DIR"\)\)\s*\.join\("windows"\)\s*\.join\("app-manifest\.xml"\)/);
});
