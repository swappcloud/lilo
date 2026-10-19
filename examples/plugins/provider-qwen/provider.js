var voices = [{"value": "Tina", "label": "Tina"}, {"value": "Cindy", "label": "Cindy"}, {"value": "Liora Mira", "label": "Liora Mira"}, {"value": "Raymond", "label": "Raymond"}, {"value": "Cici", "label": "Cici"}, {"value": "Zane", "label": "Zane"}, {"value": "Theo Calm", "label": "Theo Calm"}, {"value": "Serena", "label": "Serena"}, {"value": "Maia", "label": "Maia"}, {"value": "Evan", "label": "Evan"}, {"value": "Qiao", "label": "Qiao"}, {"value": "Momo", "label": "Momo"}, {"value": "Wil", "label": "Wil"}, {"value": "Angel", "label": "Angel"}, {"value": "Li Cassian", "label": "Li Cassian"}, {"value": "Mia", "label": "Miar"}, {"value": "Joyner", "label": "Joyner"}, {"value": "Gold", "label": "Gold"}, {"value": "Katerina", "label": "Katerina"}, {"value": "Ryan", "label": "Ryan"}, {"value": "Jennifer", "label": "Jennifer"}, {"value": "Aiden", "label": "Aiden"}, {"value": "Mione", "label": "Mione"}, {"value": "Sunny", "label": "Sunny"}, {"value": "Dylan", "label": "Dylan"}, {"value": "Eric", "label": "Eric"}, {"value": "Peter", "label": "Peter"}, {"value": "Joseph Chen", "label": "Joseph Chen"}, {"value": "Marcus", "label": "Marcus"}, {"value": "Li", "label": "Li"}, {"value": "Rocky", "label": "Rocky"}, {"value": "Sohee", "label": "Sohee"}, {"value": "Lenn", "label": "Lenn"}, {"value": "Ono Anna", "label": "Ono Anna"}, {"value": "Sonrisa", "label": "Sonrisa"}, {"value": "Bodega", "label": "Bodega"}, {"value": "Emilien", "label": "Emilien"}, {"value": "Andre", "label": "Andre"}, {"value": "Radio Gol", "label": "Radio Gol"}, {"value": "Alek", "label": "Alek"}, {"value": "Rizky", "label": "Rizky"}, {"value": "Roya", "label": "Roya"}, {"value": "Arda", "label": "Arda"}, {"value": "Hana", "label": "Hana"}, {"value": "Dolce", "label": "Dolce"}, {"value": "Jakub", "label": "Jakub"}, {"value": "Griet", "label": "Griet"}, {"value": "Eli\\u0161ka", "label": "Eli\\u0161ka"}, {"value": "Marina", "label": "Marina"}, {"value": "Siiri", "label": "Siiri"}, {"value": "Ingrid", "label": "Ingrid"}, {"value": "Sigga", "label": "Sigga"}, {"value": "Bea", "label": "Bea"}, {"value": "Chloe", "label": "Chloe"}];
// Vendor protocol belongs to this plugin. The host owns the browser and media.
var sessions = Object.create(null);
function probe() {
  return (async function () {
    var saved = null; try { saved = JSON.parse(localStorage.getItem('qwen_access_token_state') || 'null'); } catch (_) {}
    var token = (saved && saved.token) || localStorage.getItem('token');
    // Qwen can authenticate with cookies even when its token is not exposed.
    var headers = {};
    if (typeof token === 'string' && token) headers.authorization = 'Bearer ' + token;
    var response = await fetch('/api/v2/auths/', { credentials: 'include', headers: headers });
    if (!response.ok) return { ready: false };
    var body = await response.json(); var user = body.data || {};
    return { ready: !!(body.success && (user.id || user.role)), name: String(user.name || user.nickname || '').slice(0, 320), email: String(user.email || '').slice(0, 320) };
  })();
}
function negotiate(args) {
  return (async function () {
    var saved = null; try { saved = JSON.parse(localStorage.getItem('qwen_access_token_state') || 'null'); } catch (_) {}
    var token = (saved && saved.token) || localStorage.getItem('token');
    var platform = navigator.platform || '';
    var os = /Mac/.test(platform) ? 'MACOS' : /Win/.test(platform) ? 'WINDOWS' : /Linux/.test(platform) ? 'LINUX' : 'UNKNOWN';
    var now = new Date().toString();
    var response = await fetch('/api/v2/users/user/audio_chat_token', {
      method: 'POST', credentials: 'include', headers: (function () { var headers = { 'content-type': 'application/json', accept: 'application/json', source: 'web', version: '0.3.12', timezone: now.replace(/\s*\([^)]*\)$/, '') }; if (typeof token === 'string' && token) headers.authorization = 'Bearer ' + token; return headers; })(),
      body: JSON.stringify({ type: 'AudioOnly', model_id: 'omni', project_id: '', mode: 'duplex', voice: args.voice || 'Tina', timezone: now, sdp: args.sdp, temporary: false, client_info: { os_group: os, terminal_type: 'web' } })
    });
    if (!response.ok) return { connected: false };
    var body = await response.json(); var data = body.data || {};
    if (data.code === 'RateLimited' || data.times_left === 0) {
      var quota = { kind: 'daily' };
      if (Number.isInteger(data.num) && data.num >= 1 && data.num <= 168) quota.retryAt = Date.now() + data.num * 3600000;
      return { connected: false, quota: quota };
    }
    if (!body.success || typeof data.sdp_token !== 'string' || !data.sdp_token.startsWith('v=0') || data.sdp_token.length > 128000) return { connected: false };
    return { sdp: data.sdp_token };
  })();
}
function describe() {
  return { voiceProviders: [{ id: 'web', label: 'Qwen (plugin)', description: 'Qwen web voice through your own account. The plugin opens its own sign-in browser when needed.',
    transport: { kind: 'webrtc', channelLabel: 'txt', remoteChannel: true },
    settings: [{ key: 'voice', label: 'Voice', default: 'Tina', options: voices }],
    browser: { loginUrl: 'https://chat.qwen.ai/auth', homeUrl: 'https://chat.qwen.ai/', allowedHosts: ['chat.qwen.ai'], sessionProbe: probe.toString(),
      phoneForm: { entryText: '^(log in|sign in|login|accedi|entrar)$', codeSwitch: '', codeInputs: 'input[aria-label^="Verification code digit"]', phoneSwitch: '', codeNeedsFocus: false }
    },
    protocol: { inbound: { userText: true, assistantText: true, nativeToolCalls: false, images: false }, outbound: { text: true, stopSpeaking: true, systemPrompt: true, toolResult: false, image: false } }
  }] };
}
function publish(request, events) {
  if (events.length) lilo.voice.publish({ providerId: request.providerId, sessionId: request.sessionId, events: events });
}
function settings(state) {
  return { type: 'session.update', event_id: 'event_' + Date.now(), session: { input_audio_format: 'pcm16', output_audio_format: 'pcm24', input_audio_transcription: { model: 'qwen3-asr-flash-realtime' }, modalities: ['text', 'audio'], smooth_output: true, enable_search: true, instructions: [state.instructions].concat(state.notes).filter(Boolean).join('\n\n').slice(-64000), voice: state.voice } };
}
function frames(request, values) { publish(request, [{ type: 'frames', frames: values }]); }
function caption(request, state, frame) {
  var type = String(frame.type || '').replace('response.output_audio_transcript.', 'response.audio_transcript.');
  var user = type.indexOf('conversation.item.input_audio_transcription.') === 0;
  if (!user && type.indexOf('response.audio_transcript.') !== 0) return;
  var raw = frame.item_id || frame.response_id || (frame.item && frame.item.id);
  if (typeof raw !== 'string' || raw.length > 128) return;
  var id = (user ? 'user:' : 'assistant:') + raw;
  var previous = state.captions[id] || { text: '', confirmed: '', final: false };
  if (previous.final) return;
  var final = /\.(done|completed)$/.test(type); var text = previous.text;
  if (final) text = frame.transcript || frame.text || text;
  else if (/\.delta$/.test(type)) text += typeof frame.delta === 'string' ? frame.delta : '';
  else if (/\.text$/.test(type)) { previous.confirmed = (previous.confirmed + (typeof frame.text === 'string' ? frame.text : '')).slice(-32000); text = previous.confirmed + (typeof frame.stash === 'string' ? frame.stash : ''); }
  else return;
  if (typeof text !== 'string') return;
  previous.text = text.slice(-32000); previous.final = final; state.captions[id] = previous;
  var keys = Object.keys(state.captions); if (keys.length > 128) delete state.captions[keys[0]];
  if (previous.text) publish(request, [{ type: 'caption', id: 'qwen-' + request.sessionId + '-' + id, speaker: user ? 'user' : 'assistant', text: previous.text, final: final }]);
}
function voice(request) {
  var args = request.args || {}; var state = sessions[request.sessionId];
  if (request.operation === 'connect') {
    if (request.providerId !== 'web') throw new Error('Unknown Qwen provider.');
    var selectedVoice = args.settings && args.settings.voice;
    if (!voices.some(function (option) { return option.value === selectedVoice; })) selectedVoice = 'Tina';
    sessions[request.sessionId] = { voice: selectedVoice, instructions: (String(args.instructions || '') + '\nOnly respond to current user requests. Past commands have already been handled. This audio-only session cannot see screenshots.').slice(-48000), notes: [], captions: Object.create(null) };
    return lilo.browser.call(request.providerId, negotiate.toString(), { sdp: args.sdp, voice: selectedVoice });
  }
  if (request.operation === 'disconnect') { delete sessions[request.sessionId]; return {}; }
  if (!state) throw new Error('Qwen session is not active.');
  if (request.operation === 'text') {
    var text = String(args.text || '').slice(-8000);
    if (args.hidden) { state.notes.push(text); state.notes = state.notes.slice(-8); frames(request, [settings(state)]); }
    else frames(request, [{ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: text }] } }, { type: 'response.create' }]);
  } else if (request.operation === 'interrupt') frames(request, [{ type: 'response.cancel' }]);
  else if (request.operation === 'event') {
    var frame; try { frame = JSON.parse(args.frame); } catch (_) { return {}; }
    if (frame.type === 'session.created') frames(request, [settings(state)]);
    else if (frame.type === 'response.created') publish(request, [{ type: 'response_started' }]);
    else if (frame.type === 'input_audio_buffer.speech_started') publish(request, [{ type: 'input_started' }]);
    else if (frame.type === 'response.done' || frame.type === 'response.audio.done') publish(request, [{ type: 'state', state: 'connected' }]);
    else if (frame.type === 'error') publish(request, [{ type: 'error', message: 'Qwen rejected the voice request.' }]);
    caption(request, state, frame);
  }
  return {};
}
