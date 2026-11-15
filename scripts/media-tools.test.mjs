import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { catalog, assetName, downloadVerified, publishTools, validateCatalog } from './media-tools.mjs';

const bytes = Buffer.from('verified fixture');
const tool = {
  name: 'mpv', version: 'fixture', targets: ['windows-x86_64'],
  url: 'https://upstream.invalid/mpv.7z', format: '7z', entry: 'mpv.exe',
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const manifest = { mirror: 'https://github.com/swappcloud/lilo/releases/download/media-tools-v1', tools: [tool] };
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

test('retained copy works after upstream removes a release', async () => {
  const urls = [];
  const result = await downloadVerified(manifest, tool, async (url) => {
    urls.push(url);
    return url.startsWith(manifest.mirror) ? response(bytes) : response('', 404);
  });
  assert.deepEqual(Buffer.from(result), bytes);
  assert.deepEqual(urls, [manifest.mirror + '/' + assetName(tool)]);
});

test('first publication fetches upstream and checks its pinned digest', async () => {
  const urls = [];
  const result = await downloadVerified(manifest, tool, async (url) => {
    urls.push(url);
    return url === tool.url ? response(bytes) : response('', 404);
  });
  assert.deepEqual(Buffer.from(result), bytes);
  assert.deepEqual(urls, [manifest.mirror + '/' + assetName(tool), tool.url]);
});

test('corrupted mirror is rejected rather than silently overwritten', async () => {
  await assert.rejects(downloadVerified(manifest, tool, async () => response('corrupted')), /checksum/);
});

test('a redirect to HTTP cannot publish an executable even with the correct bytes', async () => {
  await assert.rejects(downloadVerified(manifest, tool, async () => {
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

test('publication refuses a bad digest and never uploads unchecked files', async () => {
  const uploads = [];
  await assert.rejects(publishTools(manifest, {
    existing: [], request: async () => response('bad'),
    upload: async (...args) => uploads.push(args),
  }), /checksum/);
  assert.equal(uploads.length, 0);
});

test('publication is resumable and never replaces retained assets', async () => {
  const uploads = [];
  await publishTools(manifest, {
    existing: [assetName(tool)], request: async () => response(bytes),
    upload: async (...args) => uploads.push(args),
  });
  assert.equal(uploads.length, 0);
  await publishTools(manifest, {
    existing: [], request: async () => response(bytes),
    upload: async (name, data) => uploads.push([name, Buffer.from(data)]),
  });
  assert.deepEqual(uploads, [[assetName(tool), bytes]]);
});

test('a missing retained asset fails release verification even if upstream works', async () => {
  const sleeps = [];
  await assert.rejects(publishTools(manifest, {
    existing: [assetName(tool)],
    request: async (url) => url === tool.url ? response(bytes) : response('', 404),
    upload: async () => assert.fail('existing assets must not be replaced'),
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    deadline: 0,
  }), /retained/i);
  assert.deepEqual(sleeps, []);
});

test('a fresh upload is verified once the mirror finishes propagating it', async () => {
  const uploads = [];
  const sleeps = [];
  let clock = 0;
  let mirrorFetches = 0;
  await publishTools(manifest, {
    existing: [],
    request: async (url) => {
      if (url === tool.url) return response(bytes);
      mirrorFetches += 1;
      return mirrorFetches <= 3 ? response('', 404) : response(bytes);
    },
    upload: async (name, data) => uploads.push([name, Buffer.from(data)]),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    now: () => clock,
    deadline: 60_000,
  });
  assert.deepEqual(uploads, [[assetName(tool), bytes]]);
  assert.deepEqual(sleeps, [5_000, 5_000]);
});

test('mirror verification gives up when an asset never becomes public', async () => {
  const sleeps = [];
  let clock = 0;
  await assert.rejects(publishTools(manifest, {
    existing: [assetName(tool)],
    request: async (url) => url === tool.url ? response(bytes) : response('', 404),
    upload: async () => assert.fail('existing assets must not be replaced'),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    now: () => clock,
    deadline: 12_000,
  }), /retained/i);
  assert.deepEqual(sleeps, [5_000, 5_000, 5_000]);
});

test('propagation retries never publish an asset whose mirror copy is corrupted', async () => {
  const sleeps = [];
  await assert.rejects(publishTools(manifest, {
    existing: [assetName(tool)],
    request: async (url) => url === tool.url ? response(bytes) : response('corrupted'),
    upload: async () => assert.fail('existing assets must not be replaced'),
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  }), /checksum/);
  assert.deepEqual(sleeps, []);
});
