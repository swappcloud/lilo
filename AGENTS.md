# AGENTS.md — LILO

Standing instructions for AI coding agents working in this repo. They apply
to every task unless the user explicitly overrides them.

## Language

- Code, identifiers and comments stay in English — including example
  utterances quoted in a comment. A Portuguese phrase there is still a
  Portuguese comment; localized phrases belong in product templates and
  structured documentation examples.
- Repository guides, specifications and other instructions stay in English.
  Multilingual examples are fine when they are structured examples such as
  command templates or language-pack content.

## Cross-platform — always

- **Windows, macOS and Linux are equally supported desktop platforms.** Linux
  also runs headless on compatible computers and boards. No OS or board is the
  primary target. Platform-specific features declare their availability.
- Never assume a shell, an interpreter or an OS tool exists. Anything the app
  executes needs a per-platform form: plugins ship `entries`
  (`windows`/`macos`/`linux`/`unix`), Rust goes through `cfg(windows)` with a
  real fallback, and `scripts/` stays POSIX `sh` or Node — no bashisms, no
  PowerShell-only steps unless they are labelled as such and a Windows path is
  provided.
- A plugin or feature that genuinely cannot exist on an OS says so with
  `platforms` and is skipped there; it never fails to start on that OS.
- Paths, env vars, signal handling, process control and encodings differ.
  Write UTF-8 explicitly where a platform would default to a code page, and
  never hard-code `/tmp`, `/bin/sh`, `~` or `\r\n` behaviour.
- When touching the plugin host, the wake helper, media provisioning or the
  phone login, keep the other two OSes compiling and working; verify with
  `cargo test --workspace` (Linux/macOS code is exercised by CI-less builds, so
  keep platform branches small and unit-tested).

## Product

- **LILO**: free, independent desktop interface for realtime voice services, with
  embedded web browsing and the user's own provider accounts. Voice conversations,
  local commands and plugins support language practice, notes, focus, music and weather.
  Desktop targets: Windows, macOS and Linux — Tauri v2 (Rust) + React 19 + TypeScript +
  Vite 7 + Zustand. The shared core also powers a headless Linux daemon for commands and
  compatible plugins, local media, and standalone ChatGPT voice through an optional
  browser/audio host controlled from the phone. A paired desktop satellite remains a separate option.
  Standalone daemon voice currently supports ChatGPT; Claude, Grok and Qwen voice
  adapters are not available there. Physical-board audio, first-boot Wi-Fi and
  peak resource behavior still need validation. Keep
  voice-only command flows usable without UI. Provider subscriptions, availability and
  quotas apply separately.
- Uses the user's **own web accounts** through the web voice
  paths: ChatGPT (`chatgpt.com/realtime/wm`) Claude (`claude.ai` voice mode), Grok and Qwen, with additional providers
  declared by plugins. See the provider protocol docs and `docs/provider-plugins.md`.
  One user, their own account; provider plans and quotas apply.
  Never pool, share or commit credentials.
- Hard constraints: **free software** — no API keys, no paid API dependencies, no local
  **LLMs or TTS** (no Ollama, no Whisper, no local speech synthesis).
  Small wake-word and STT models are allowed on headless targets when they are
  OSS, keyless, and *measured* to run comfortably on the intended hardware.
  Linux desktop and daemon share local PocketSphinx wake-phrase recognition.
  Keep wake capture suspended during provider voice; manual activation remains
  an alternative on every platform. Playback backends beyond
  YouTube (Spotify, Alexa, …) are welcome as `Resolver`/`Player` variants as
  long as they need no paid API.
- Brand: **LILO** — "Listen In. Listen Out. Your voice interface for AI."
  Default wake phrase: `"lilo"`.
- Brand assets are vector, one source: `app/src/shared/brand/logoPaths.ts`. Copies
  live in `index.html` (splash, renders before the bundle), `public/logo.svg`
  (favicon) and `src-tauri/app-icon.svg` (regenerate platform icons with
  `npx tauri icon src-tauri/app-icon.svg`). The LILO character
  (`app/src/features/voice/lilo/`) is the default visualizer; its ink is the user's
  palette (`--accent`/`--accent2`), never hard-coded black.

## UI/UX — always clean

- Settings follow the Apple-style grouped-card pattern
  (`.set-group` / `.sec` / `.set-card`) with hairline row rhythm. Preserve it.
- **Never glue elements together.** Spacing rules:
  - Stacked buttons → wrap in `.btn-stack` (flex column, `gap: 10px`), never
    bare siblings inside `.stack` (its gap is 0 inside cards).
  - Stacked callouts (`.notice` / `.errorbox`) already get margins via CSS —
    verify they don't touch after any markup change.
  - Boxed callouts and tool cards keep their own padding/border; they must
    never inherit row hairlines.
- Check spacing/rhythm whenever adding adjacent elements. If in doubt, build
  and look at the panel.
- No emojis in UI unless requested. System font stack only (CSP forbids
  remote fonts).

## Workflow

- Verify every change: `npm run typecheck`, `npm test`, `npm run build`;
  `cargo test --workspace` from the repo root.
- **Do not test in the browser** — the user tests in the app via
  `npm run dev` (frees ports 1420/1421/1430).
- The wake helper is the fragile seam (AVAudioEngine + TCC): after touching
  `src-tauri/wake/lilo-wake.swift`, rebuild with `scripts/build-wake.sh`, commit
  the binary, and confirm in the app that the log shows `helper READY` and a
  spoken phrase starts a session. A helper that crashes is reported through
  `wake-blocked` now, but never ship audio-path changes that were not seen
  working. Decoupling first: a feature that needs undocumented framework
  territory (switching input devices under AVAudioEngine, for example) gets its
  own design and test protocol, not a quick patch.
- Workspace `.tmp/` for temp files and session logs
  (`.tmp/logs/lilo.log` — read it to diagnose voice/wake issues).
- Never read or edit: `node_modules/`, `dist/`, `target/`, `src-tauri/target/`,
  `*.lock`, `.env*`, IDE files, logs.
- Ask before creating branches or commits. No commits unless requested.
- Commits in this repo are authored with the identity in the repo-local git
  config. The remote is `swappcloud/lilo`.
- Commit messages follow Conventional Commits: `type(scope): summary` (for
  example, `fix(dev): install missing npm dependencies`).
- Before anything reaches the remote, check that no secret, account identifier
  or personal address is in the tree *or* in the history.

## Workspace layout

- **Start from `docs/atlas.md`** — the file-by-file map and a "where is…"
  index — instead of reading the tree. Update its line whenever a module is
  added, moved, split or removed.

- `crates/lilo-core` — command protocol, media, tools, settings, accounts.
  **Must never depend on `tauri`**: it runs on headless Linux devices.
- `src-tauri` — the desktop app: window, WebView, login, SDP gateway, phone
  login, macOS wake helper.
- `app/` — the web app (Vite root): `index.html`, `public/`, `src/`. The repo
  root stays for the Rust workspace, docs and scripts; `dist/` is built there.
- Workspace root `Cargo.toml` pins shared dependency versions; the build target
  directory is `/target`, not `src-tauri/target`.
- Supported media tools are provisioned into the host's data directory with
  pinned versions and verified SHA-256 digests (`crates/lilo-core/src/media/provision.rs`):
  yt-dlp and Deno on supported targets, and mpv where a trusted package exists.
  Linux uses a system/configured mpv because no pinned Linux mpv package is
  provided. Never ask the user to install a tool by hand where a spec exists;
  never take a digest from the download server. Adding a platform needs a real
  artifact and digest.
- Resource budget for anything in `lilo-core`: no heavyweight crates (no
  `regex`, no unicode-normalization), matching stays O(n) per caption, mpv runs
  with a bounded cache.
- **Providers are external plugins too** — core (stores, settings UI, command
  router, Rust) owns the contract; an adapter translates its vendor's API into
  it, never the reverse. Front: `app/src/providers/contract.ts` (types +
  runtime registry), one folder per adapter, and `registry.ts` as the only
  place that installs them. Rust: `src-tauri/src/providers/` with the
  `WebBackend` registry behind the generic `provider_login*` commands. The UI
  branches on declared capabilities, never on a provider id, and an empty
  registry is a renderable state.
- **Plugins are the extension mechanism** — tools, voice commands and UI all
  arrive through one registry (`crates/lilo-core/src/plugins`). Contract and
  marketplace layout: `docs/plugins.md`; working examples:
  `examples/plugins/{hello,notes,pomodoro,macapps,screen}`. Two runtimes, one
  contract: the default is `"runtime": "quickjs"` — one `.js` file in the
  embedded engine, identical on every OS and sandboxed, reaching the machine
  only through `lilo.exec` on a binary the manifest declared as `exec:<bin>`;
  `"runtime": "process"` is the escape hatch (JSON over stdio, any language,
  per-OS `entries` or `platforms`) for a plugin that must be a process — a
  long-lived child in another runtime; every bundled example is quickjs. Never
  a `dylib`, and the host renders UI from a declarative description, never from
  shipped HTML/JS. Prefer quickjs; a new example or a port starts there. After
  changing a plugin, run
  `scripts/build-marketplace.sh` — a test fails when the index and the files
  disagree.

## Architecture notes

- One module owns one thing. A feature grows by adding a module beside its
  peers, not by widening a shared one: the vision channel lives in
  `src-tauri/src/vision.rs` (not inside `execute_tool`), the screen relay in
  `app/src/store/screenRelay.ts` (not in the plugin notifier), the screen
  capture in the `screen` plugin (not in the host). No mixed logic, no
  circular reach; extending or fixing means touching the one file that owns
  the concern.

- DataChannel `oai-events`: every outbound event is wrapped as
  `{type:"data_message", data:"<json>"}`. Text via `relay_message`,
  barge-in via `action_request`/`stop_speaking`, captions from
  `chat_message_delta`. Offer SDP must be CRLF + trailing newline.
- Login: an embedded webview per backend + injected same-origin script +
  `tauri-voice://` callback, dispatched by the `WebBackend` registry; the
  window is then kept hidden and reused as that backend's transport (ChatGPT:
  the SDP bridge, with the browser's TLS fingerprint and cookies; Claude: the
  voice socket). Every backend reports on one `provider-login-status` event
  carrying its provider id. Phone login: LAN server
  (`src-tauri/src/phonelogin.rs`) + QR serves a page that answers what the
  PC's login page asks — e-mail or phone number, password, code
  (`providers/phone_form.rs` fills the backend's own form, so its captchas
  stay real) — in a window shown cloaked (`providers/cloak.rs`: WebKit stops
  rendering a hidden page). Social-only accounts (Google/Apple) need a
  password or phone number first. Capture reuses the desktop account event.
  Same-Wi-Fi only.
- Claude voice: the hidden `claude.ai` window is a socket relay only — WebKit
  holds `getUserMedia` (and audio) back in a page nobody can see, so the
  microphone and playback live in the main window and PCM16 crosses as base64.
  Engine reports ride the inlined Tauri plugin `claude-voice` (claude.ai's CSP
  blocks loopback `fetch`), granted to that origin by
  `src-tauri/capabilities/claude-voice.json`. The system prompt goes in as the
  conversation's first text turn, because the socket has no client text frame.
- Storage keys: `"lilo/..."` (localStorage) and the Tauri app-data dir
  (identifier `com.lilo.app`) — renaming either logs the user out.
- On **Windows/WebView2**, wake word recognition uses native WinRT
  `SpeechRecognizer` (WebView2 has no speech service: the in-page recognizer
  only answers `error:network`), in `src-tauri/src/wake/windows.rs`. macOS uses
  the Swift helper bundle (`src-tauri/binaries/LiloWake.app`, spawned directly
  by `src-tauri/src/wake/macos.rs` — never a bare sidecar binary, TCC kills
  those). Linux: `crates/lilo-core/src/wake/` owns PocketSphinx keyword recognition
  and PulseAudio capture, with desktop and daemon lifecycle adapters.
  The wake contract (commands, `wake-word` event, phrase prefs) is
  OS-independent; engines live one file per OS under `src-tauri/src/wake/`.
- Toolchain: Node 22, npm 10, Rust stable, Xcode swiftc (macOS arm64).
