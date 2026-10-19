// LILO — Claude voice engine.
//
// Runs inside the hidden claude.ai webview: the voice WebSocket must live on
// that origin (cookies + Cloudflare). It is a socket relay and nothing more.
// WebKit holds `getUserMedia` (and audio) back while a page is not visible, so
// the microphone and playback live in LILO's main window; PCM crosses over as
// base64 — up via `window.__liloClaudeVoice.sendPcm`, down as `audio` reports.
//
// Reports ride Tauri IPC (`plugin:claude-voice|report`), not fetch: claude.ai's
// CSP only lets the page connect to itself.
//
// Config comes from `window.__liloVoiceCfg`:
//   { token, org, voice, model, language, locale, speed, instructions, conversationId }
//
// The voice socket has no text message, so `instructions` (LILO's persona,
// command manifest and language rule) go in first as a normal text turn of the
// same conversation; voice mode then talks with that context.
(() => {
  'use strict';

  const cfg = window.__liloVoiceCfg || {};
  // Rust re-injects until the engine reports `ready`: one run per session per
  // page. A different token is a new session, so the old engine goes first.
  if (window.__liloVoiceToken === cfg.token) return;
  try {
    window.__liloClaudeVoice?.stop?.();
  } catch (_) {}
  window.__liloClaudeVoice = null;
  window.__liloVoiceToken = cfg.token;

  const tag = '[lilo-claude-voice]';
  const state = { ws: null, stopped: false, requests: new AbortController() };

  let queue = [];
  let flushTimer = null;
  let keepAlive = null;
  let clockSync = null;

  const post = (events) => {
    try {
      const ipc = window.__TAURI_INTERNALS__;
      if (!ipc || typeof ipc.invoke !== 'function') {
        console.error(tag, 'Tauri IPC is not available on this page');
        return;
      }
      ipc
        .invoke('plugin:claude-voice|report', { token: cfg.token, events })
        .catch((error) => console.error(tag, 'report failed', error));
    } catch (error) {
      console.error(tag, 'report failed', error);
    }
  };

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    post(batch);
  };

  /** Control events go at once; audio is grouped into short batches. */
  const emit = (event, immediate) => {
    if (state.stopped) return;
    queue.push(event);
    if (immediate) {
      flush();
      return;
    }
    if (!flushTimer) flushTimer = setTimeout(flush, 30);
  };

  const toBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  const fromBase64 = (text) => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };

  // First thing on the wire: proves the IPC path works.
  emit({ type: 'boot' }, true);

  // Cancellation must exist before the first fetch, not only after the
  // socket opens. Otherwise a stopped startup can leave a live relay behind.
  const teardown = () => {
    if (state.stopped) return;
    state.stopped = true;
    state.requests.abort();
    clearInterval(keepAlive);
    clearInterval(clockSync);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    queue = [];
    const ws = state.ws;
    state.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(1000, 'client stop'); } catch (_) {}
    }
  };
  window.__liloClaudeVoice = {
    stop: teardown,
    sendPcm: (chunk) => {
      if (!state.stopped && state.ws?.readyState === 1 && chunk) state.ws.send(fromBase64(chunk));
    },
  };

  async function createConversation() {
    // LILO tracks the last conversation this call chain used: reuse it so a
    // reconnect (wake word, dropped socket) continues the same claude.ai
    // conversation instead of leaving a fresh one in the user's history.
    if (cfg.conversationId) return cfg.conversationId;
    const res = await fetch(`/api/organizations/${cfg.org}/chat_conversations`, {
      signal: state.requests.signal,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        uuid: crypto.randomUUID(),
        name: '',
        ...(cfg.model ? { model: cfg.model } : {}),
      }),
    });
    if (!res.ok) throw new Error(`conversation create: ${res.status}`);
    const body = await res.json();
    if (!body || !body.uuid) throw new Error('conversation create: no uuid');
    return body.uuid;
  }

  /** Sends the instructions as the conversation's first turn. Once the reply
   *  starts streaming the turn is stored, so the rest of the reply is not
   *  waited for: reading it to the end held voice back by seconds. */
  async function sendInstructions(conversationId) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    state.requests.signal.addEventListener('abort', cancel, { once: true });
    if (state.requests.signal.aborted) cancel();
    const timer = setTimeout(() => controller.abort(), 40000);
    try {
      const res = await fetch(
        `/api/organizations/${cfg.org}/chat_conversations/${conversationId}/completion`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            prompt: cfg.instructions,
            parent_message_uuid: '00000000-0000-4000-8000-000000000000',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            locale: cfg.locale || 'en-US',
            attachments: [],
            files: [],
            sync_sources: [],
            rendering_mode: 'messages',
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`instructions: ${res.status} ${detail}`);
      }
      const reader = res.body && res.body.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let seen = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          seen += decoder.decode(value, { stream: true });
          if (seen.includes('content_block_start') || seen.includes('content_block_delta')) {
            reader.cancel().catch(() => {});
            break;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      state.requests.signal.removeEventListener('abort', cancel);
    }
  }

  /** The server can take the voice from the account rather than the socket
   *  URL, so the choice is saved there as well, as claude.ai's settings do. */
  async function saveVoiceSettings() {
    const settings = {};
    if (cfg.voice) settings.voice_preference = cfg.voice;
    if (cfg.speed) settings.voice_speed = Number(cfg.speed);
    if (cfg.language) settings.voice_language_code = cfg.language;
    if (!Object.keys(settings).length) return;
    try {
      const res = await fetch('/api/account/settings', {
        signal: state.requests.signal,
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!res.ok) emit({ type: 'warning', message: `voice settings: ${res.status}` }, true);
    } catch (error) {
      emit({ type: 'warning', message: `voice settings: ${String((error && error.message) || error)}` }, true);
    }
  }

  async function run() {
    if (!cfg.org) throw new Error('missing Claude organization');
    const voiceSettings = saveVoiceSettings();

    emit({ type: 'stage', stage: 'conversation' }, true);
    const conversationId = await createConversation();
    if (state.stopped) return;

    if (cfg.instructions) {
      emit({ type: 'stage', stage: 'instructions' }, true);
      try {
        await sendInstructions(conversationId);
      } catch (error) {
        // Voice without the persona still beats no voice at all.
        emit({ type: 'warning', message: String((error && error.message) || error) }, true);
      }
    }

    await voiceSettings;
    if (state.stopped) return;
    emit({ type: 'stage', stage: 'socket' }, true);
    const params = new URLSearchParams({
      input_encoding: 'linear16',
      input_sample_rate: '16000',
      input_channels: '1',
      output_format: 'pcm_16000',
      language: cfg.language || 'en',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tts_speed: Number(cfg.speed || 1).toFixed(2),
      server_interrupt_enabled: 'true',
      client_aec: 'true',
      client_platform: 'web_claude_ai',
      entry_source: 'voice_button',
      connect_reason: 'initial',
      voice: cfg.voice || 'buttery',
      model: cfg.model || 'claude-haiku-4-5-20251001',
      thinking_mode: 'off',
      thinking_explicit: 'true',
    });
    const ws = new WebSocket(
      `wss://claude.ai/api/ws/voice/organizations/${cfg.org}/chat_conversations/${conversationId}?${params}`,
    );
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    let opened = false;
    ws.onopen = () => {
      if (state.stopped) return;
      opened = true;
      ws.send(JSON.stringify({ type: 'tools_register', data: { tools: [] } }));
      keepAlive = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'keep_alive' }));
      }, 4000);
      let clockSeq = 0;
      clockSync = setInterval(() => {
        if (ws.readyState !== 1) return;
        clockSeq += 1;
        ws.send(
          JSON.stringify({ type: 'clock_sync_ping', seq: clockSeq, t1: Math.round(performance.now()) }),
        );
      }, 2000);
      emit({ type: 'ws_open' }, true);
      emit({ type: 'ready', conversationId }, true);
    };

    ws.onmessage = (event) => {
      if (state.stopped) return;
      if (typeof event.data !== 'string') {
        emit({ type: 'audio', data: toBase64(event.data) });
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (message.type === 'clock_sync_pong') return;
      emit({ type: 'ws', message }, message.type !== 'transcript_interim' && message.type !== 'tts_word');
    };

    ws.onclose = (event) => {
      if (state.stopped) return;
      if (!opened) {
        // Refused before it opened (bad params, limits): fail the start.
        emit({ type: 'error', message: `voice socket refused (close ${event.code})` }, true);
      } else {
        emit({ type: 'closed', code: event.code, clean: event.wasClean }, true);
      }
      teardown();
    };

    ws.onerror = () => {
      if (state.stopped) return;
      if (opened) emit({ type: 'error', message: 'voice websocket error' }, true);
    };

    window.__liloClaudeVoice.conversationId = conversationId;
  }

  run().catch((error) => {
    if (state.stopped) return;
    console.error(tag, error);
    emit({ type: 'error', message: String((error && error.message) || error) }, true);
  });
})();
