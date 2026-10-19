# Claude.ai voice mode — the protocol LILO speaks

claude.ai's voice mode runs over a WebSocket the web client opens from a
signed-in page. LILO drives it from a hidden `claude.ai` window. The protocol
is undocumented and can change without notice; points not confirmed are
marked *to verify*. "How LILO drives it" at the end is the shape the
adapter takes. The ChatGPT counterpart is `chatgpt-voice-protocol.md`.

> One user, their own account. LILO never pools or shares credentials.

## Why this socket and not the two known ones

Claude Code — and the web `Read aloud` button — use two independent WebSockets
that the community has already documented:

| Socket | Purpose |
|---|---|
| `/api/ws/speech_to_text/voice_stream?encoding=linear16&…` | dictation (PCM16 in, `TranscriptText`/`TranscriptEndpoint` out) |
| `/api/ws/text_to_speech/text_stream?output_format=pcm_16000&voice=…` | read-aloud (`text_chunk`/`close_stream` in, raw PCM out) |

The web **voice mode** uses neither. It opens one full-duplex socket under
`/api/ws/voice/…` that carries VAD, turn-taking, assistant streaming and both
audio directions. That is the endpoint LILO targets: a single connection, the
closest thing Claude has to the ChatGPT realtime path.

## Endpoint

```
wss://claude.ai/api/ws/voice/organizations/{org_uuid}/chat_conversations/{conversation_uuid}
  ?input_encoding=opus&input_sample_rate=16000&input_channels=1
  &output_format=opus_48000_32&language=en-US&timezone=Europe%2FRome
  &tts_speed=1.00&server_interrupt_enabled=true&client_aec=true
  &client_platform=web_claude_ai&entry_source=voice_button&connect_reason=initial
  &voice=buttery&model=claude-haiku-4-5-20251001
  &thinking_mode=off&thinking_explicit=true
  &audio_input_device=builtin_mic&audio_output_route=builtin_speaker
```

| Param | Captured value | Notes |
|---|---|---|
| `input_encoding` / `input_sample_rate` / `input_channels` | `opus` / `16000` / `1` | mic format. `linear16` @ 16 kHz mono **verified with real audio** |
| `output_format` | `opus_48000_32` | assistant voice. `pcm_16000` / `pcm_24000` **verified** (10 ms frames); `pcm_48000` rejected (close 1003) |
| `language` / `timezone` | `en-US` / IANA zone | server answers with `voice_language_status`. The web client sends its own voice-language code, not the browser tag: `pt-BR` → `pt`, `it-IT` → `it`, while `en-US`, `en-GB`, `pt-PT`, `es-419` stay regional (mapping in `claudeLanguage`, `app/src/providers/claude/voiceCatalog.ts`) |
| `tts_speed` | `1.00` | Settings → Voice → Speed: Slow `0.8`, Normal `1`, Fast `1.2` |
| `server_interrupt_enabled` | `true` | server-side barge-in; it decides when the user interrupted |
| `client_aec` | `true` | the **client** is expected to cancel its own playback echo |
| `voice` | `buttery` | Settings → Voice → Style. **Per language**: English (and any language without its own) has `buttery`, `airy`, `mellow`, `glassy`, `rounded`; others have their own, e.g. `pt-BR-clara`/`pt-BR-suave`, `it-dolce`/`it-chiara`, `fr-douce`, `de-hell`/`de-sanft`. The client swaps the voice when the language changes |
| `model` | `claude-haiku-4-5-20251001` | voice default was Haiku; plan limits apply |
| `thinking_mode` / `thinking_explicit` | `off` / `true` | |
| `entry_source` / `connect_reason` | `voice_button` / `initial` | other `connect_reason` values (resume?) *to verify* |
| `audio_input_device` / `audio_output_route` | labels | diagnostics |

**Auth is cookie-only** (no bearer): `sessionKey`, `cf_clearance` (User-Agent
bound), `lastActiveOrg`. Requests must come from the `claude.ai` origin —
Cloudflare challenges non-browser clients, which is why the reference
implementation was built by driving real browser traffic. `Origin: https://claude.ai`
is sent on the upgrade.

## Frames

Two kinds on one socket: **JSON text frames** (control) and **binary frames**
(Opus audio, both directions).

### Client → server

| Frame | Cadence | Purpose |
|---|---|---|
| binary Opus | continuous, ~50/s (20 ms) | microphone. Streaming starts immediately on connect, before any speech |
| `{"type":"tools_register","data":{"tools":[]}}` | once, right after init | the web app registers zero tools |
| `{"type":"keep_alive"}` | ~4 s | liveness |
| `{"type":"clock_sync_ping","seq":N,"t1":<ms>}` | ~2 s, `t1` = `performance.now()` | paired with `clock_sync_pong` (playback/AEC alignment) |

### Server → client

| Frame | Meaning |
|---|---|
| `{"type":"session_server_initialized"}` | socket ready; client answers with `tools_register` |
| `{"type":"voice_language_status", "status":"ok", "reason":"session_start", "active_language":"en", "requested_language":"en-US", "auto_switch_enabled":false, "supported_languages":[…]}` | language negotiation; ~50 languages |
| `{"type":"message_sse","event":{…}}` | assistant turn, wrapped in Anthropic SSE vocabulary: `conversation_ready`, `message_start`, `content_block_start`, `content_block_delta` (`text_delta`), `content_block_stop`, `message_delta`, `message_stop`. **This is the caption stream** |
| `{"type":"transcript_interim","text":"Hello there, can you","utterance_seq":3}` | user transcript, progressive, replaces previous |
| `{"speech_end_offset_ms":2980,"type":"user_input_end"}` | server VAD closed the user turn; the assistant reply follows automatically |
| `{"type":"playback_start","turn_id":"…","parent_uuid":"…","kind":"reply"}` | assistant audio starts — the turn's audio is the binary frames that follow |
| `{"type":"tts_word","text":"You've","pts_ms":1835}` | word-level timing for the audio being played (`pts_ms` = presentation timestamp); payload confirmed |
| `{"type":"tts_segment_end", …}` | one synthesized segment (sentence) finished |
| `{"type":"message_complete", …}` | assistant message fully delivered (after `message_sse` `message_stop`) |
| `{"type":"playback_end", …}` | the turn's audio finished playing |
| `{"type":"transcription_start"}` | server listening for the next user turn |
| `{"type":"server_interrupt"}` | user barged in: stop local playback immediately |
| `{"type":"clock_sync_pong","seq":N,"server_t2_ms":…,"server_t3_ms":…}` | clock sync reply |
| binary Opus (`opus_48000_32`) | assistant voice, bursts aligned with `playback_start` |

## Turn lifecycle

```
connect ─ init ─ language_status
  no audio for ~2.5 s                (server opens the conversation itself;
                                      with the account rate-limited this was the
                                      usage-limit notice — a normal greeting is
                                      the expected case otherwise)
    ← message_sse … text_delta …
    ← playback_start ─ tts_word … tts_segment_end … message_complete … playback_end
  user speaks (mic binary streams continuously)
    ← transcript_interim …            (cumulative full utterance, replaces prior)
    ← user_input_end                  (endpoint detected; can fire more than once)
    ← message_sse … text_delta …      (captions, same SSE shapes as text chat)
    ← playback_start                  (binary audio follows)
    ← tts_word … tts_segment_end … message_complete … playback_end
    ← transcription_start             (listening again)
  user speaks over the assistant
    ← server_interrupt                (client stops playback; no request needed)
```

There is **no client-side "respond" trigger**: the server owns turn-taking.
A rate-limited account gets a normal assistant message (“You've reached your
usage limit. We can talk again in about 46 minutes.”) — voice counts against the
plan like any other chat.

## What this means for LILO

- **One socket, one bridge target.** Unlike the STT+TTS pair, voice mode needs
  no REST per turn (the conversation exists first; create it once per session —
  *to verify* whether the web creates a new conversation when starting voice on
  a fresh chat).
- **Captions arrive as protocol events**: `transcript_interim` (user) and `message_sse`
  `text_delta` (assistant) map 1:1 onto `onCaption`.
- **Barge-in is server-side** (`server_interrupt`), and the client is expected
  to do echo cancellation (`client_aec=true`) — LILO's playback must not be
  re-captured by its own mic, or the server will keep interrupting itself.
- **Transport boundary**: the socket must run on the `claude.ai` origin
  (cookies + Cloudflare), so it lives in a hidden webview, like the ChatGPT SDP
  bridge. Audio crosses the window boundary (mic PCM in, playback PCM out).
- **Codec**: PCM16 both ways — `input_encoding=linear16` +
  `output_format=pcm_16000` (10 ms frames out). No Opus and no WebCodecs: the
  webview sends raw PCM from an AudioWorklet and plays incoming frames through
  Web Audio.

## Observed behaviour

Handshake, one parameter override per run, no microphone audio:

| Override | Result |
|---|---|
| control `opus` / `opus_48000_32` | init + language OK, ~236 binary frames in 6 s |
| `input_encoding=linear16` | handshake OK |
| `output_format=pcm_16000` | **accepted**; 320-byte frames (10 ms PCM16) |
| `output_format=pcm_24000` | **accepted**; 480-byte frames (10 ms PCM16) |
| `output_format=pcm_48000` | **rejected**: server closes 1003 before init |
| fresh conversation | create, then connect: init + language OK |

Real microphone, PCM16 both ways (`input_encoding=linear16` +
`output_format=pcm_16000`), no Opus anywhere:

- the server transcribed the stream: progressive `transcript_interim`, each
  message the cumulative utterance so far (replace, do not append)
- `user_input_end` carries `speech_end_offset_ms` and can fire more than once
  per spoken phrase (endpointing)
- `tts_word` payload confirmed: `{"type":"tts_word","text":"You've","pts_ms":1835}`
- `server_interrupt` fired right after `transcription_start` when the user
  started speaking — server barge-in works as documented
- **PCM16 both ways is viable end to end** → no WebCodecs/Opus in LILO
- one `error` text frame appeared (payload unknown; the socket itself stayed
  clean: close 1000)

Every connection received, **without any microphone audio**, one unsolicited
assistant message ~2.5 s after connect. Its text was “You've reached your usage
limit…" — the rate-limit notice, not a fixed greeting; the identical byte
counts across conversations are the same sentence synthesized twice. Treat any
unsolicited turn as a normal assistant turn. (A real greeting on an account with available voice access: *to verify*.)

Conversation creation is a plain `POST /api/organizations/{org}/chat_conversations`
with `{"uuid":"<uuidv4>","name":""}` → **201** and the full conversation object
(settings, model, timestamps). Voice works on the fresh conversation
immediately.

## Open questions

1. `error` frame payload (seen once, end of a rate-limited session).
2. `connect_reason` values on reconnect/resume.
3. Unsolicited opening turn on an account with available voice access (greeting?).

## Voices

The voice list reaches the client as `speech_input.supported_languages`
(`code`, `display_name`, `voices[]` with `id`, `display_name`, `preview_url`
under `assets.claude.ai/voice/selection/`) in the account's feature config;
`voiceCatalog.ts` mirrors it, falling back to the five English voices. The web
client keeps the voice as `claude-selected-voice` and the speed as
`claude-voice-speed`; the language lives on the account as
`voice_language_code`.

There is no client→server text frame on the socket: instructions go in as the
conversation's first text turn (point 6 below).

## How LILO drives it

Everything inside the hidden window does not work (point 2), so the work is
split:

1. **The hidden `claude.ai` window is a socket relay only**
   (`src-tauri/assets/claude-voice-engine.js`). It creates the conversation,
   optionally posts LILO's instructions as the first text turn, opens the voice
   WebSocket, and forwards frames. It owns no audio.
2. **Microphone and playback live in the main window**
   (`app/src/providers/shared/pcmAudio.ts`). WebKit holds `getUserMedia` back
   while a page is not visible: the engine stalled forever at that call in the
   hidden window. Mic audio is captured at 16 kHz, cut into 40 ms PCM16 chunks,
   base64-encoded and handed to the engine through the `claude_voice_audio`
   command; the assistant's PCM comes back as `audio` reports and is scheduled
   back to back. Both directions share one `AudioContext`, so the webview's
   echo canceller sees the playback it has to remove (`client_aec=true`).
3. **Reports ride Tauri IPC, not HTTP.** claude.ai sends
   `connect-src 'self'`, which blocks a loopback `fetch` to a local sink. The
   engine calls `plugin:claude-voice|report` instead — an inlined Tauri plugin
   whose single command is granted to `https://claude.ai/*` by
   `src-tauri/capabilities/claude-voice.json`, with a per-session random token.
   Tauri falls back to `postMessage` when the IPC custom protocol is blocked.
4. **Start fails loudly.** Rust re-injects the engine every 400 ms (a
   navigation discards whatever was evaluated) until it reports `ready`, or
   `error`, with a 60 s ceiling; every stage is logged, so a failure names
   where it stopped. `ready` carries the conversation id, so a reconnect can
   ask for the same one instead of starting a fresh conversation every time.
5. **The hidden window survives a restart** and is created invisible with
   background throttling disabled. Its injected login script reports the
   session on every page load; for a window that is already the transport,
   that is a silent account refresh, never a navigation.
6. **The system prompt** (persona + command manifest + reply-language rule) is
   posted to `.../chat_conversations/{id}/completion` before the socket opens,
   because the voice socket has no client text frame. A failure there is a
   warning, not a failed session. Reading that turn's reply to the end held
   voice back 2–7 s; the engine stops reading at the first content block,
   by which point the turn is stored. The voice choice is also saved to the
   account (`PATCH /api/account/settings` with `voice_preference`,
   `voice_speed`, `voice_language_code`, as claude.ai's own settings do),
   in parallel, in case the server prefers it over the URL.
7. **Captions**: every `message_sse` event is double-wrapped —
   `{"type":"content_block_delta","data":{"delta":{...},"index":...,"type":"content_block_delta"}}`
   — unlike the flat Anthropic Messages API shape the field names suggest;
   the assistant's fields live under `.data`, not on the event itself.
   `transcript_interim` replaces the user's open turn (it is cumulative);
   `user_input_end` is ignored, since it fires mid-sentence more than once
   per phrase (see point 8) and closing on it marks half a sentence final.
   `message_sse` `text_delta` carries the assistant's text, but the caption
   follows the voice: nothing shows before the turn's first audio, then
   `tts_word` (`pts_ms` taken from the turn's first audio) reveals the text up
   to the last word heard (`spokenText.ts` lines the voiced words up with the
   written text). Without `tts_word` it shows available text as soon as audio starts. The turn stays open
   while its audio plays and closes on `playback_end`, `message_complete`
   (after a grace period, in case `playback_start` is still on its way) or
   `server_interrupt`.
8. **The assistant can start replying mid-sentence.** Claude's own VAD ends
   the user's turn (and triggers a reply) whenever it detects a pause, not
   necessarily when the user is actually done — the same over-eager
   endpointing as point 7's `user_input_end`. The user's caption turn is kept
   open (not `final`) when the reply starts, specifically so a free-text
   command ("play `<song>`") still waits out the router's own settle
   debounce (`SLOT_SETTLE_MS`, `router.rs`) on the real, still-growing text
   instead of firing on whatever partial slot had arrived by then; it only
   closes for display once that debounce would already have run.

Working end to end: connect → `ready`, mic chunks up, captions both ways,
server VAD, assistant audio played, barge-in, instructions delivered,
conversation resumed across a reconnect.
