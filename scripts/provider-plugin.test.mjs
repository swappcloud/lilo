import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../examples/plugins/provider-qwen/provider.js', import.meta.url), 'utf8');
function fixture(result = { sdp: 'v=0\r\n' }) {
  const outputs = []; const calls = [];
  const context = vm.createContext({ lilo: { voice: { publish: value => outputs.push(value) }, browser: { call: (...args) => { calls.push(args); return result; } } } });
  vm.runInContext(source, context);
  const request = (operation, args = {}) => context.voice({ providerId: 'web', sessionId: 'fixture-session', operation, args });
  return { context, outputs, calls, request };
}
test('Qwen plugin owns negotiation and declares a remote txt channel', () => {
  const { context, request, calls } = fixture();
  const spec = context.describe().voiceProviders[0];
  assert.equal(spec.transport.kind, 'webrtc'); assert.equal(spec.transport.remoteChannel, true); assert.equal(spec.transport.channelLabel, 'txt');
  request('connect', { sdp: 'v=0\r\n', instructions: 'Fixture instructions' });
  assert.equal(calls[0][0], 'web'); assert.match(calls[0][1], /audio_chat_token/); assert.equal(calls[0][2].sdp, 'v=0\r\n');
});
test('hidden notes update context without requesting speech; explicit text requests speech', () => {
  const { request, outputs } = fixture(); request('connect');
  request('text', { text: 'The prior request has completed.', hidden: true });
  assert.equal(outputs[0].events[0].frames[0].type, 'session.update');
  assert.equal(JSON.stringify(outputs).includes('response.create'), false);
  request('text', { text: 'A new request', hidden: false });
  assert.equal(outputs[1].events[0].frames[1].type, 'response.create');
});
test('captions follow spoken transcript, revise stash and never expose generated text ahead of speech', () => {
  const { request, outputs } = fixture(); request('connect');
  const event = frame => request('event', { frame: JSON.stringify(frame) });
  event({ type: 'response.text.done', item_id: 'turn', text: 'The whole generated answer' });
  assert.equal(outputs.length, 0);
  event({ type: 'response.audio_transcript.text', item_id: 'turn', text: 'Hello ', stash: 'wor' });
  event({ type: 'response.audio_transcript.text', item_id: 'turn', text: '', stash: 'world' });
  assert.equal(outputs.at(-1).events[0].text, 'Hello world');
  event({ type: 'response.audio_transcript.done', item_id: 'turn', transcript: 'Hello world' });
  assert.equal(outputs.at(-1).events[0].final, true);
  const count = outputs.length; event({ type: 'response.audio_transcript.done', item_id: 'turn', transcript: 'Hello world' });
  assert.equal(outputs.length, count);
  request('disconnect'); assert.throws(() => request('event', { frame: '{}' }), /not active/);
});
test('browser negotiation preserves structured quota without forwarding private server details', async () => {
  const { context } = fixture();
  const calls = []; const now = Date.now();
  const browser = vm.createContext({ localStorage: { getItem: key => key === 'token' ? 'synthetic-test-token' : null }, navigator: { platform: 'Win32' }, args: { sdp: 'v=0\r\n' }, fetch: async (path, options) => { calls.push({ path, options }); return { ok: true, json: async () => ({ success: false, data: { code: 'RateLimited', num: 2, details: 'Private arbitrary payload' } }) }; } });
  const result = await vm.runInContext('(' + context.negotiate.toString() + ')(args)', browser);
  assert.equal(result.quota.kind, 'daily'); assert.ok(result.quota.retryAt >= now + 7200000);
  assert.equal(JSON.stringify(result).includes('Private'), false);
  const body = JSON.parse(calls[0].options.body); assert.equal(body.client_info.os_group, 'WINDOWS'); assert.equal(body.type, 'AudioOnly');
});


test('selected plugin voice reaches negotiation and session updates; invalid choices use the declared default', () => {
  const { context, request, calls, outputs } = fixture();
  const field = context.describe().voiceProviders[0].settings[0];
  assert.equal(field.default, 'Tina');
  assert.equal(field.options.length, 54);
  request('connect', { sdp: 'v=0\r\n', settings: { voice: 'Liora Mira' } });
  assert.equal(calls[0][2].voice, 'Liora Mira');
  request('event', { frame: JSON.stringify({ type: 'session.created' }) });
  assert.equal(outputs[0].events[0].frames[0].session.voice, 'Liora Mira');
  request('disconnect');
  request('connect', { sdp: 'v=0\r\n', settings: { voice: 'not-a-voice' } });
  assert.equal(calls[1][2].voice, 'Tina');
});

test('Qwen declares real-form phone sign-in and its segmented verification code selector', () => {
  const { context } = fixture();
  const browser = context.describe().voiceProviders[0].browser;
  assert.equal(browser.loginUrl, 'https://chat.qwen.ai/auth');
  assert.ok(new RegExp(browser.phoneForm.entryText, 'i').test('Log in'));
  assert.equal(browser.phoneForm.codeInputs, 'input[aria-label^="Verification code digit"]');
  assert.equal(browser.phoneForm.phoneSwitch, '');
});
