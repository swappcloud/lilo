/** Install and run pinned media tools on the native release target. */
import { execFileSync } from 'node:child_process';
import { privacyBuildEnvironment } from './release-privacy.mjs';
import { withToolchains } from './toolchains.mjs';
import { TARGETS } from './release-plan.mjs';

const target = process.argv[2];
if (process.argv.length !== 3 || !TARGETS.some((entry) => entry.target === target)) {
  throw new Error('Expected a supported native release target');
}
const env = privacyBuildEnvironment(withToolchains(process.env), undefined, undefined, process.platform, target);
execFileSync('cargo', [
  'test', '-p', 'lilo-core', '--release', '--target', target,
  'really_installs_every_tool_this_platform_supports', '--', '--ignored', '--nocapture',
], { stdio: 'inherit', env });
