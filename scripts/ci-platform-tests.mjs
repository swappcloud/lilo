import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const windowsPatterns = [
  /^\.github\/workflows\//,
  /^src-tauri\/build\.rs$/,
  /^scripts\/ci-platform-tests\.mjs$/,
  /^src-tauri\/windows\//,
  /(^|\/)windows\.rs$/,
  /^scripts\/(build|toolchains|release-test|release-privacy)\.(mjs|test\.mjs)$/,
  /^crates\/lilo-core\/src\/plugins\/http\.rs$/,
];

const macosPatterns = [
  /^\.github\/workflows\//,
  /^src-tauri\/build\.rs$/,
  /^scripts\/ci-platform-tests\.mjs$/,
  /^src-tauri\/wake\//,
  /^src-tauri\/Info\.plist$/,
  /(^|\/)macos\.rs$/,
  /^scripts\/(build-wake|prepare-release|release-test)\.(sh|mjs)$/,
  /^crates\/lilo-core\/src\/plugins\/http\.rs$/,
];

export function selectPlatformTests(paths) {
  return {
    windows: paths.some((path) => windowsPatterns.some((pattern) => pattern.test(path))),
    macos_intel: paths.some((path) => macosPatterns.some((pattern) => pattern.test(path))),
  };
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error('Usage: node scripts/ci-platform-tests.mjs <base-sha> <head-sha>');

  const changed = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  const selected = selectPlatformTests(changed);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(output, `windows=${selected.windows}\nmacos_intel=${selected.macos_intel}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
