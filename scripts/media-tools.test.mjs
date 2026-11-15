import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { catalog, downloadVerified, validateCatalog } from './media-tools.mjs';

const bytes = Buffer.from('verified fixture');
const tool = {
  name: 'mpv', version: 'fixture', targets: ['windows-x86_64'],
  url: 'https://upstream.invalid/mpv.7z', format: '7z', entry: 'mpv.exe',
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const manifest = { tools: [tool] };
const response = (body, status = 200) => new Response(body, { status });

test('catalog covers every existing managed platform without duplicate tools', () => {
  validateCatalog(catalog);
  for (const target of ['windows-x86_64', 'macos-aarch64', 'macos-x86_64', 'linux-x86_64', 'linux-aarch64']) {
    assert.ok(catalog.tools.some((entry) => entry.targets.includes(target)), target);
  }
  assert.throws(() => validateCatalog({ ...manifest, tools: [tool, tool] }), /duplicate/i);
  assert.throws(() => validateCatalog({ ...manifest, tools: [{ ...tool, url: 'http://unsafe.invalid' }] }), /HTTPS/);
  assert.throws(() => validateCatalog({ ...manifest, tools: [{ ...tool, sha256: 'bad' }] }), /SHA-256/);
});

test('media tools are external dependencies, never hosted in this repository', () => {
  for (const entry of catalog.tools) {
    assert.ok(!entry.url.includes('/swappcloud/lilo/'), entry.url);
  }
  assert.throws(() => validateCatalog({
    ...manifest,
    tools: [{ ...tool, url: 'https://github.com/swappcloud/lilo/releases/download/media-tools-v1/mpv.7z' }],
  }), /upstream/);
});

test('a pinned dependency downloads from its own upstream release', async () => {
  const urls = [];
  const result = await downloadVerified(tool, async (url) => {
    urls.push(url);
    return response(bytes);
  });
  assert.deepEqual(Buffer.from(result), bytes);
  assert.deepEqual(urls, [tool.url]);
});

test('corrupted downloads are rejected', async () => {
  await assert.rejects(downloadVerified(tool, async () => response('corrupted')), /checksum/);
});

test('a removed upstream release is reported as unavailable', async () => {
  await assert.rejects(downloadVerified(tool, async () => response('', 404)), /unavailable/);
});

test('a redirect to HTTP cannot install an executable even with the correct bytes', async () => {
  await assert.rejects(downloadVerified(tool, async () => {
    const result = response(bytes);
    Object.defineProperty(result, 'url', { value: 'http://unsafe.invalid/tool' });
    return result;
  }), /HTTPS/);
});

test('catalog refuses archive paths that escape on another OS', () => {
  for (const entry of ['../mpv.exe', '/mpv.exe', 'C:/mpv.exe', 'bin\\mpv.exe']) {
    assert.throws(() => validateCatalog({ ...manifest, tools: [{ ...tool, entry }] }), /archive entry/);
  }
});
