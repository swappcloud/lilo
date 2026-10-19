/** Daily release planning; no writes to GitHub and no local credentials. */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { MANIFESTS, TARGETS, releaseVersion } from "./release-plan.mjs";
import { nextVersion, setVersion } from "./bump-version.mjs";
import { freezeChanges, releaseChanges } from "./changelog.mjs";
import { UPDATE_TARGETS } from "./update-artifacts.mjs";

const numericVersion = /^\d+\.\d+\.\d+$/;
export function compareVersions(a, b) {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export function nightlyPlan(current, sha, releases) {
  if (!numericVersion.test(current) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid nightly release input");
  const versions = releases.filter((r) => numericVersion.test(r.tag_name));
  versions.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const latest = versions[0];
  if (latest) {
    const names = new Set((latest.assets ?? []).map((a) => a.name));
    const complete = !latest.draft && names.has("latest.json") &&
      TARGETS.every((t) => t.files.every((f) => names.has(f.asset(latest.tag_name)))) &&
      UPDATE_TARGETS.every((t) => names.has(t.asset(latest.tag_name)) && names.has(t.asset(latest.tag_name) + ".sig"));
    if (complete && latest.target_commitish === sha) {
      return { build: false, tag: latest.tag_name, targets: [], reason: "main is already released" };
    }
    if (!complete) {
      const missing = TARGETS.filter((target) => {
        const update = UPDATE_TARGETS.find((item) => item.target === target.target);
        return target.files.some((file) => !names.has(file.asset(latest.tag_name))) ||
          !names.has(update.asset(latest.tag_name)) || !names.has(`${update.asset(latest.tag_name)}.sig`);
      });
      // Reuse every successful target even while the release is a draft.
      // If only release metadata is missing, rebuild all targets to let the
      // publisher regenerate it from their signed updater artifacts.
      const targets = missing.length === 0 ? TARGETS : missing;
      return { build: true, tag: latest.tag_name, targets, reason: "finish an incomplete release" };
    }
  }
  const tag = latest && compareVersions(latest.tag_name, current) >= 0 ? nextVersion(latest.tag_name, "patch") : current;
  return { build: true, tag, targets: TARGETS, reason: "main has unpublished changes" };
}

/** Apply the selected version only to the disposable CI checkout. */
export function prepareNightlyVersion(version, read, write) {
  if (!numericVersion.test(version)) throw new Error("Invalid nightly version");
  const current = releaseVersion(read);
  let changelog = read("CHANGELOG.md");
  if (current !== version) {
    try { changelog = freezeChanges(changelog, version); }
    catch (error) {
      if (!String(error.message).includes("Describe this release")) throw error;
      changelog = freezeChanges(changelog.replace("## [Unreleased]", "## [Unreleased]\n\n- Publish the latest changes from main."), version);
    }
    for (const file of Object.keys(MANIFESTS)) write(file, setVersion(file, read(file), current, version));
    write("CHANGELOG.md", changelog);
  }
  releaseChanges(changelog, version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--prepare") {
    prepareNightlyVersion(process.argv[3], (file) => readFileSync(file, "utf8"), (file, text) => writeFileSync(file, text, "utf8"));
  } else {
    const repository = process.env.GH_REPO;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Invalid repository");
    const releases = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/releases?per_page=100`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    const plan = nightlyPlan(releaseVersion((file) => readFileSync(file, "utf8")), process.env.RELEASE_SHA, releases);
    const matrix = plan.targets.map(({ platform, os, target, bundles }) => ({ platform, os, target, bundles }));
    console.log(`Nightly release: ${plan.reason}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build=${plan.build}\ntag=${plan.tag}\nmatrix=${JSON.stringify(matrix)}\n`, "utf8");
  }
}
