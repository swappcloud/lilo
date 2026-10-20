# Architecture

How LILO is put together, and why. The short version: **one core crate that
runs without a window, one desktop shell that gives it a window, and a web app
that renders the interface and carries the realtime media.**

```
┌───────────────────────────── Tauri window ──────────────────────────────┐
│  React 19 web app (Zustand stores, captions, LILO character, scenes)    │
│     │ mic + audio  ─────────────────────────────────────────┐           │
│     │ RTCPeerConnection            audio (WebRTC, peer-to-peer)          │
│     │ DataChannel "oai-events"                                ▼           │
│     │ typed IPC                                     chatgpt.com          │
│     ▼                                                                    │
│  src-tauri: window, sign-in webview, SDP gateway, wake helper,          │
│             phone login, logging                                        │
│     │                                                                    │
│     ▼                                                                    │
│  crates/lilo-core: commands, plugins, media, tools, settings, storage,  │
│                    weather, location   (never depends on tauri)         │
└──────────────────────────────────────────────────────────────────────────┘
```

## The three layers

**`crates/lilo-core` — the headless core.** Everything that must also run on a
headless Linux device with no display: the command protocol (manifest, registry, matcher,
router), the plugin system (loader, sidecars, registry, marketplace, event bus),
media (mpv control, resolvers, provisioning), tools (time, web search), settings,
accounts, storage, and the first-party weather and location plugins. It must
never gain a `tauri` dependency; that constraint is what keeps the headless
target honest.

**`src-tauri` — the desktop shell.** The window and webview, one embedded
sign-in window per backend and its network bridge (`src/providers/`), the SDP
gateway and account bindings, media provisioning, the macOS wake helper, phone
login over LAN, and the log file. It owns paths and the async runtime; logic
lives in the core.

**`app/src/` — the web app.** React 19 + Zustand + Vite. It carries the realtime
media (WebRTC lives in the webview), renders everything from the stores, and
reaches the backend only through typed IPC wrappers in `app/src/lib/gateway.ts`.
The UI is a *contributor*, never a requirement: `lilo-core` never assumes a
window exists.

The daemon routes commands and plugins and can run standalone ChatGPT voice
through its optional Linux browser/audio host, controlled from the phone. That
provider-specific path does not make desktop transports or provider-plugin voice
adapters available on Linux. It also registers the shared media service; actual
playback depends on a supported resolver, an available system player and audio
endpoint. Resource measurements and hardware validation are recorded in
[Linux validation evidence](linux-validation.md).

## Voice backends

A backend is an **adapter**, and core never knows one by name.

- **Front**: `app/src/providers/contract.ts` holds the contract — capabilities,
  protocol capabilities, declared settings, the factory — plus a runtime
  registry. Each adapter lives in its own folder (`chatgpt/`, `claude/`, `grok/`, `mock/`) with its transport, vendor catalog, mark, Rust bridge and tests, and
  `registry.ts` is the only place that installs them. The settings UI renders
  from declarations, the session store routes on protocol capabilities
  (`outbound.text`, `outbound.systemPrompt`), and a provider id is a string
  validated at runtime. Removing an adapter is deleting a folder and a line.
- **Rust**: `src-tauri/src/providers/` declares a `WebBackend` per backend (its
  window, injected script, and how to read an account out of what that script
  reports). Opening the window, storing the account, keeping the window as a
  hidden transport and reporting status are shared, behind
  `provider_login`, `provider_login_cancel` and `provider_profile_refresh`.
- **The system prompt is one prompt.** The session store builds persona +
  command manifest + reply-language rule once, before connecting. A backend
  with a live text channel receives it as hidden turns; one without (Claude)
  receives it through `ConnectOptions.instructions` and delivers it its own way.

### ChatGPT web voice

WebRTC in the webview, SDP proxied through the signed-in `chatgpt.com` window,
captions over the `oai-events` DataChannel. See the session walkthrough below.

### Claude voice mode

One full-duplex WebSocket on the `claude.ai` origin, PCM16 both ways. The
hidden `claude.ai` window is a **socket relay only**: WebKit holds capture and
audio back in a page that is not visible, so the microphone and playback run in
the main window (`providers/shared/pcmAudio.ts`) and audio crosses the boundary
as base64 — up through the `claude_voice_audio` command, down as `audio`
reports. Those reports ride an inlined Tauri plugin granted to claude.ai,
because the site's CSP allows no loopback `fetch`. The socket carries no client
text frame, so LILO's instructions go in as the conversation's first text turn
before voice opens. Protocol details: [`claude-voice-protocol.md`](claude-voice-protocol.md).

### Grok live voice

The `grok.com` webview owns a cookie-authenticated WebSocket; the main window
handles 24 kHz PCM16 microphone capture and playback. Restricted inlined IPC
reports carry frames to the adapter. The account file contains only a local
session marker. Desktop and phone sign-in use the generic backend registry.
Protocol and capability details: [`grok-voice-protocol.md`](grok-voice-protocol.md).

## A voice session

1. The frontend creates the peer connection and gets an offer SDP.
2. `create_voice_session(offerSdp, voice, voiceMode, languageCode, resume)`
   reaches Rust, which posts the offer to `chatgpt.com/realtime/wm` **from
   inside the signed-in chatgpt.com webview** — browser TLS fingerprint, cookies
   and Cloudflare clearance included — and returns the answer. Offers are
   normalized to CRLF with a trailing newline; the webview's SDP parser is
   strict. If the bridge is unavailable the gateway falls back to posting from
   Rust.
3. Audio flows peer-to-peer between the webview and chatgpt.com. **The access
   token never enters the main window's JavaScript**; the sign-in webview hands
   a fresh token to Rust through a private `tauri-voice://` navigation.
4. Live events arrive on the `oai-events` DataChannel. Every outbound message is
   wrapped as `{"type":"data_message","data":"<json>"}`; text goes out as
   `relay_message`, barge-in as `action_request: stop_speaking`, and captions
   come back as `chat_message_delta`. `app/src/providers/chatgpt/events.ts` parses that stream
   tolerantly.
5. `voice_session_id` ↔ account bindings are kept in Rust with a six-hour TTL,
   so stale sessions are reaped and one user stays one account.

## Voice commands

Commands are **data**, matched locally in Rust — the model is not asked to route
anything:

- A caption (partial or final) reaches `handle_utterance(text, speaker, turnId,
  isFinal)`.
- The registry matches templates (`[optional|group]`, `(required|alternative)`,
  `{free text slot}`, `<name>`) with an O(n) token matcher — no regex crate, so
  small Linux devices stay responsive. `slotWords` keeps broad phrases honest ("make it {mood}"
  only claims mood words). A command can carry fixed `args` for phrases that say
  what they mean without a slot ("turn off the background" → `mood=off`).
- Free-text slots are debounced by the router until the caption settles; a
  `requiresConfirm` command parks the intent behind a confirmation bar.
- Outcomes carry **effects** the frontend applies: run a tool, end the call,
  toast, earcon, send a hidden note to hold the model, ask for confirmation.

The full contract, including the headless Linux device plan for wake word and STT, is
[`command-protocol.md`](command-protocol.md).

## Plugins

The extension mechanism for tools, voice commands and UI.

- A plugin is one `.js` file in the embedded QuickJS engine (the default,
  identical on every OS) or, when it needs the OS, a **process** (JSON over
  stdio) — never a `dylib`. It answers a
  `describe` handshake with its tools, commands and a **declarative UI** — the
  host renders settings fields, status rows and action buttons with its own
  controls, so no plugin ships HTML or JavaScript into the webview.
- First-party plugins run **in-process** (weather, location) and use the same
  provider contract as a sidecar.
- The `ToolRegistry` owns identity: duplicate ids and clashing tool names are
  rejected at registration. Routing goes through the owner, and calls run after
  the registry lock is released — a slow plugin never blocks the others.
- Plugins publish and subscribe to **topics** on a retained event bus, so a
  publisher never needs to know who listens (weather follows `location.changed`).
- **Marketplace**: a repository with an `index.json` and one folder per plugin.
  Every file carries a SHA-256, downloads are staged and verified before the
  swap, an update replaces the folder but keeps `data/`, `settings.json` and a
  deactivation, and only one install operation runs at a time.
- **Activation**: `.disabled` inside the plugin folder takes a plugin out of
  service (no tools, commands or page) while keeping everything else; uninstall
  removes the folder whole. Every active plugin that declares settings, status
  or actions gets its own page in the settings navigation.

Contract and examples: [`plugins.md`](plugins.md), `examples/plugins/`.

## Media

- **mpv** is the playback engine, driven over its JSON IPC socket. yt-dlp
  resolves streams (both binaries are downloaded by the app into
  `<app data>/bin` with pinned versions and verified SHA-256 digests).
- Music ducks while the assistant talks; the state is derived from recent
  assistant activity, not from a caption flag the web path often omits.
- mpv runs an `astats` filter whose metadata is read back over IPC, so the
  visualizers (LILO, orb, bars) follow the **real loudness** of the track
  instead of guessing. Polling is one attempt per tick at 20 Hz, never holding
  the player lock across a retry.
- A watchdog Lua script makes mpv quit if the host stops beating, so a crashed
  app never leaves a song playing.

## Scenes and the character

- Plugins name a **scene** from a fixed vocabulary (`clear`, `sun`, `clouds`,
  `fog`, `rain`, `snow`, `storm`, `heat`, `cold`, `none`) — they never ship
  drawing code. The host paints it on one canvas, ported from the reference
  `weather-motion` effect: accent-coloured particles, rain with splashes, fog
  banks, and a storm with forked lightning and a flash.
- The **LILO character** is an SVG figure driven outside React: pure geometry
  (`liloModel.ts`) plus an attribute writer (`liloRenderer.ts`) inside a
  requestAnimationFrame loop, so 60 fps never means 60 re-renders. It takes the
  user's palette as ink, plays the intro as the startup splash, then glides onto
  the stage as the same model.

## The desktop shell

One main window, two styles, chosen in Settings → Appearance and persisted in
`<app data>/shell.json` with the window position:

- **Companion** (default): a transparent, undecorated, always-on-top window
  with only LILO, its speech bubble and — while music is loaded — five media
  buttons. Everything else lives in the native menus: the macOS menu bar, the
  tray on every OS, and a right-click on LILO. The window lets clicks through
  to the desktop except over the parts the frontend reports (`[data-hit]`);
  Rust polls the cursor and toggles `set_ignore_cursor_events`. Settings and
  history open in a **second window**, the panel, so LILO stays on screen and
  the companion window never changes frame (reframing it is what left a grey
  slab behind LILO).
- **Classic**: the decorated app window with the full stage and panels.

### One owner, many views

The voice session stays in the main window — a hidden page loses its
microphone and audio — so the panel window owns nothing. The main window is
the **owner**: session, microphone, wake word, scene and every store's
persistence. The panel is a **view** (`app/src/app/windowBridge.ts`):

- The owner sends it a snapshot of the mirrored stores (session, preferences,
  plugins, wake, alert), then only what changed, coalesced and numbered; a
  gap costs a fresh snapshot (`mirror.ts`, unit-tested).
- In the panel every action of a mirrored store is a request to the owner.
  The owner runs it and its reply carries the changes it caused, so an
  awaited action reads back the new state as it would in one window.
- Functions with owner effects that are not store actions (committing the
  settings draft, the scene, reading audio devices, starting a session) are
  declared with `ownerCall` (`windowRole.ts`): in place in the owner, sent
  across from a panel.
- The settings draft and toasts are the panel's own and are not mirrored.

A new panel-side feature follows the same rule: read mirrored state, write
through an action or an `ownerCall`, never through module state of its own.

`src-tauri/src/shell.rs` builds the window (it is declared `create: false` so
transparency is set from birth), tells the page its style through an
initialization script and a `lilo://shell-style` event, and owns the menus;
the frontend pushes session flags and localized labels back with
`shell_state`. Wayland reports no cursor position, so there the companion
window keeps its clicks.

## Startup

1. The window is created **hidden** — a fresh WKWebView paints white for its
   first frames, and that white frame is what the splash exists to remove.
2. `index.html` already contains the splash (inline CSS, the vector mark), so
   `main.tsx` shows the window the moment the bundle runs.
3. Rust provisions the media binaries and loads the plugins in the background,
   reporting progress through `lilo://startup`; the splash narrates it.
4. When startup reports done, LILO's waveforms become a face and glide onto the
   stage; the stage figure takes over the very same model.

## Wake word

The contract is OS-independent (`set_wake_watch`, a `wake-word` event, phrase
preferences); the implementation is not:

- **macOS**: a Swift helper bundle (`src-tauri/binaries/LiloWake.app`, built by
  `scripts/build-wake.sh`) owns the microphone and the on-device recogniser. It
  must stay a real `.app`: TCC keys microphone grants to the responsible process
  and its Info.plist strings. It downmixes multichannel input (a call leaves the
  mic in a voice-processing layout the recogniser cannot read), listens on the
  built-in microphone when the default output is a Bluetooth headset (opening
  the headset's own mic would drop it out of A2DP into HFP and collapse the
  music), and, after three minutes without a single recognition reaction while
  buffers keep arriving, reports `DEAF` — the host answers by respawning the
  helper.
- **Windows / WebView2**: native WinRT `SpeechRecognizer` with a phrase list
  constraint (`src-tauri/src/wake/windows.rs`). WebView2 ships no speech
  service, so the in-page Web Speech API only ever fails with `error:network`.
- **Linux**: local PocketSphinx keyword recognition and PulseAudio PCM capture
  in `crates/lilo-core/src/wake/`. The desktop emits the same wake events as
  other platforms; the daemon starts its configured provider/account while
  idle. Capture stops before provider voice starts and when disabled.

A direct local command such as “stop the music” can run through the shared command router without a provider when the wake listener is enabled. Saying the wake phrase follows the provider path. Manual activation is an alternative everywhere. Windows finite phrase mode exposes registered English literal commands; free-text slots require a recognizer that supplies dictation. This ingress has not yet been validated with a live microphone. Linux uses the distribution's
BSD-licensed PocketSphinx 0.8 ABI and English acoustic model, with explicit
LILO pronunciations. Custom phrases require dictionary words; unsupported
phrases report a block. No local LLM or TTS is needed.

Linux release preparation bundles the model, capture binary, native libraries
and redistribution notices. Debian packages declare runtime dependencies;
AppImages include their additional libraries. Source setup provisions the
Debian/Ubuntu packages, and the daemon runtime image includes them directly.

The phone can enable/disable wake listening and reports off, starting,
listening or blocked status. Recorded-audio acceptance verifies keyword
recognition, unrelated-speech rejection and silence. See [Linux validation](linux-validation.md)
for measurements. Spoken LILO activation, noise/music rejection, microphone
handover and representative x86-64/ARM64 devices still need acceptance.

## Storage

- `<app data>/` (identifier `com.lilo.app`): `bin/` (mpv, yt-dlp),
  `plugins/<id>/` (`plugin.json`, `settings.json`, `data/`, `.disabled`),
  `accounts.json`, `settings.json`, logs. In a workspace checkout the log is
  `.tmp/logs/lilo.log`.
- `localStorage` holds UI preferences under `"lilo/…"` (theme, palette,
  language, wake phrase, visualizer). Renaming either store logs the user out.
- The frontend forwards its own log lines through `log_line`, so UI decisions
  land in the same file as the backend.

## Budgets and invariants

- No heavyweight crates in the core (no `regex`, no unicode-normalization);
  matching stays O(n) per caption.
- Particle counts scale with the window and are capped; DPR is capped at 1.5;
  the scene canvas only runs while a scene is visible.
- The player lock is never held across a retry; IPC reads are bounded.
- `lilo-core` builds and tests without a window, and that is enforced by its
  dependency list, not by convention.

## Dynamic provider plugins

Installed plugins declare a private voice lifecycle through `plugins/voice.rs`.
The frontend registry creates a media adapter from that declaration and removes
it on disable/uninstall, without importing the vendor. Browser-backed QuickJS
plugins use the optional `plugins/browser.rs` port; the desktop implementation
in `plugin_browser.rs` owns profiles, origin checks, sign-in and callback bounds.
The plugin owns requests and event translation. Private voice events go only
to the main owner window; other plugins receive no retained speech stream.
The Qwen example uses this path. See [provider plugins](provider-plugins.md)
and [privacy/data handling](../PRIVACY.md).
