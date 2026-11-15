/** Verify every pinned media dependency is installable from its own upstream release. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const catalog = JSON.parse(readFileSync(new URL('../crates/lilo-core/src/media/downloads.json', import.meta.url), 'utf8'));
const formats = new Set(['executable', 'zip', '7z', 'tar.gz', 'zip-tar.gz']);

export function validateCatalog(manifest) {
  const seen = new Set();
  if (!manifest.tools?.length) throw new Error('Media catalog is empty');
  for (const tool of manifest.tools) {
    if (!/^[a-z0-9-]+$/.test(tool.name) || !tool.version || !formats.has(tool.format)) throw new Error('Invalid media tool');
    if (!/^[a-f0-9]{64}$/.test(tool.sha256)) throw new Error('Invalid pinned SHA-256');
    if (!tool.url.startsWith('https://') || new URL(tool.url).username || new URL(tool.url).password) throw new Error('Media downloads require HTTPS without credentials');
    if (tool.url.includes('/swappcloud/lilo/')) throw new Error('Media tools must come from their own upstream release');
    if (tool.format !== 'executable' && (!tool.entry || tool.entry.startsWith('/') || tool.entry.includes('..') || tool.entry.includes('\\'))) throw new Error('Unsafe archive entry');
    if (tool.entry?.includes(':')) throw new Error('Unsafe archive entry');
    if (tool.format === 'zip-tar.gz' && !/^[a-z0-9.-]+\.tar\.gz$/.test(tool.archive ?? '')) throw new Error('Unsafe nested archive');
    if (tool.minimum_macos !== undefined && (!Number.isInteger(tool.minimum_macos) || tool.minimum_macos < 10 || !tool.targets.every((target) => target.startsWith('macos-')))) throw new Error('Invalid minimum macOS');
    if (!tool.targets?.length) throw new Error('Tool has no supported target');
    for (const target of tool.targets) {
      if (!/^(windows|macos|linux)-(x86_64|aarch64)$/.test(target)) throw new Error('Unsupported media target');
      const key = `${tool.name}/${target}/${tool.minimum_macos ?? 0}`;
      if (seen.has(key)) throw new Error(`Duplicate tool for ${target}`);
      seen.add(key);
    }
  }
}

const requestDownload = (url) => fetch(url, { signal: AbortSignal.timeout(180_000) });

export async function downloadVerified(tool, request = requestDownload) {
  const response = await request(tool.url);
  if (!response.ok) throw new Error(`${tool.name} ${tool.version}: pinned download unavailable (HTTP ${response.status})`);
  if (response.url && !response.url.startsWith('https://')) throw new Error('Media downloads require HTTPS redirects');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== tool.sha256) {
    throw new Error(`${tool.name} ${tool.version}: checksum mismatch`);
  }
  return bytes;
}

async function main() {
  validateCatalog(catalog);
  if (process.argv[2] !== '--verify') throw new Error('Usage: node scripts/media-tools.mjs --verify');
  for (const tool of catalog.tools) {
    await downloadVerified(tool);
    console.log(`${tool.name} ${tool.version} (${tool.targets.join(', ')}): verified`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
