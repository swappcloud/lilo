/** Use the installer's release profile and privacy flags for native tests. */
import { execFileSync } from "node:child_process";
import { privacyBuildEnvironment } from "./release-privacy.mjs";
import { withToolchains } from "./toolchains.mjs";
import { TARGETS } from "./release-plan.mjs";

const target = process.argv[2];
if (process.argv.length !== 3 || !TARGETS.some((entry) => entry.target === target)) throw new Error("Expected a supported release target");
execFileSync("cargo", ["test", "--workspace", "--release", "--target", target], {
  stdio: "inherit", env: privacyBuildEnvironment(withToolchains(process.env)),
});
