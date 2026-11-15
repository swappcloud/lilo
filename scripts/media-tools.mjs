/** Retain verified media downloads before publishing an app that depends on them. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const catalog = JSON.parse(readFileSync(new URL('../crates/lilo-core/src/media/downloads.json', import.meta.url), 'utf8'));
const repository = 'swappcloud/lilo';
const tag = 'media-tools-v1';
const formats = new Set(['executable', 'zip', '7z', 'tar.gz', 'zip-tar.gz']);

export function assetName(tool) {
  return `${tool.name}-${tool.sha256}.${tool.format === 'executable' ? 'bin' : tool.format}`;
}

export function validateCatalog(manifest) {
  if (manifest.mirror !== `https://github.com/${repository}/releases/download/${tag}`) {
    throw new Error('Media mirror must be the retained LILO release');
  }
  const seen = new Set();
  if (!manifest.tools?.length) throw new Error('Media catalog is empty');
  for (const tool of manifest.tools) {
    if (!/^[a-z0-9-]+$/.test(tool.name) || !tool.version || !formats.has(tool.format)) throw new Error('Invalid media tool');
    if (!/^[a-f0-9]{64}$/.test(tool.sha256)) throw new Error('Invalid pinned SHA-256');
    if (!tool.url.startsWith('https://') || new URL(tool.url).username || new URL(tool.url).password) throw new Error('Media downloads require HTTPS without credentials');
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

export async function downloadVerified(manifest, tool, request = requestDownload, retainedOnly = false) {
  const urls = [manifest.mirror + '/' + assetName(tool), ...(!retainedOnly ? [tool.url] : [])];
  for (const url of urls) {
    let response;
    try { response = await request(url); }
    catch { continue; }
    if (!response.ok) continue;
    if (response.url && !response.url.startsWith('https://')) throw new Error('Media downloads require HTTPS redirects');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== tool.sha256) {
      throw new Error(`${tool.name} ${tool.version}: checksum mismatch; refusing publication`);
    }
    return bytes;
  }
  throw new Error(`${tool.name} ${tool.version}: ${retainedOnly ? 'retained asset' : 'pinned download'} unavailable`);
}

// GitHub accepts an archive before it serves it: a fresh asset answers 404 at the
// public download URL for about a minute. Publish every missing archive first and
// only then verify the whole mirror against a deadline, instead of racing each
// upload. A wrong digest or an unsafe redirect still fails immediately.
const mirrorPollMs = 5_000;
const mirrorDeadlineMs = 5 * 60_000;
const pause = (milliseconds) => new Promise((resume) => setTimeout(resume, milliseconds));

export async function publishTools(manifest, {
  existing, request = requestDownload, upload, sleep = pause, now = Date.now, deadline = mirrorDeadlineMs,
}) {
  validateCatalog(manifest);
  for (const tool of manifest.tools) {
    const name = assetName(tool);
    if (existing.includes(name)) continue;
    const bytes = await downloadVerified(manifest, tool, request);
    await upload(name, bytes);
  }
  for (const tool of manifest.tools) {
    const started = now();
    for (;;) {
      try {
        await downloadVerified(manifest, tool, request, true);
        break;
      } catch (error) {
        const unavailable = /retained asset unavailable/.test(String(error?.message));
        if (!unavailable || now() - started >= deadline) throw error;
        console.warn(`${assetName(tool)}: not served by the mirror yet, retrying`);
        await sleep(mirrorPollMs);
      }
    }
  }
}

async function main() {
  validateCatalog(catalog);
  const mode = process.argv[2];
  if (mode === '--verify') {
    for (const tool of catalog.tools) {
      await downloadVerified(catalog, tool);
      console.log(`${tool.name} ${tool.version} (${tool.targets.join(', ')}): verified`);
    }
    return;
  }
  if (mode !== '--publish') throw new Error('Usage: node scripts/media-tools.mjs --verify | --publish');
  if (process.env.GH_REPO !== repository || !/^[a-f0-9]{40}$/.test(process.env.RELEASE_SHA ?? '')) {
    throw new Error('Publishing requires the LILO repository and a full release commit');
  }
  const gh = (args) => execFileSync('gh', [...args, '--repo', repository], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`);
  if (response.status === 404) {
    gh(['release', 'create', tag, '--target', process.env.RELEASE_SHA, '--prerelease', '--latest=false',
      '--title', 'LILO retained media tools', '--notes', 'Content-addressed media archives verified against hashes pinned in the LILO source. Keep this release and every asset: distributed apps depend on them.']);
  } else if (!response.ok) {
    throw new Error(`Cannot inspect retained media release: HTTP ${response.status}`);
  }
  const { assets } = JSON.parse(gh(['release', 'view', tag, '--json', 'assets']));
  const directory = fileURLToPath(new URL('../.tmp/media-tools/', import.meta.url));
  mkdirSync(directory, { recursive: true });
  await publishTools(catalog, {
    existing: assets.map((asset) => asset.name),
    upload: async (name, bytes) => {
      const path = resolve(directory, name);
      writeFileSync(path, bytes);
      // Deliberately no --clobber: published archives must never be replaced.
      gh(['release', 'upload', tag, path]);
      console.log(`${name}: retained`);
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
