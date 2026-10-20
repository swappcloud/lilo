/** Use the installer's release profile and privacy flags for native tests. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertPrivateDataAbsent, privacyBuildEnvironment } from "./release-privacy.mjs";
import { withToolchains } from "./toolchains.mjs";
import { TARGETS } from "./release-plan.mjs";

const target = process.argv[2];
if (process.argv.length !== 3 || !TARGETS.some((entry) => entry.target === target)) throw new Error("Expected a supported release target");
const env = privacyBuildEnvironment(withToolchains(process.env), undefined, undefined, process.platform, target);
execFileSync("cargo", ["test", "--workspace", "--release", "--target", target], { stdio: "inherit", env });
// Test harnesses and tiny fixtures do not exercise the installer's actual
// dependency graph. Audit the application before a PR can reach release CI.
execFileSync("cargo", ["build", "--release", "--target", target, "--bin", "lilo", "--features", "tauri/custom-protocol"], { stdio: "inherit", env });
const directory = resolve(env.CARGO_TARGET_DIR || "target");
const binary = join(directory, target, "release", target.includes("windows") ? "lilo.exe" : "lilo");
assertPrivateDataAbsent(readFileSync(binary), [homedir(), process.cwd()]);
console.log(`Release binary privacy audit passed for ${target}`);
