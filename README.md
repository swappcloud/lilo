# LILO — Listen In. Listen Out.

<p align="center">
  <img src="docs/media/lilo.gif" width="300" alt="LILO: the brand mark wakes up, looks around, listens and answers">
</p>

<p align="center">
  <a href="https://lilo.swappscloud.com"><strong>lilo.swappscloud.com</strong></a>
</p>

LILO is a **free, independent voice interface for realtime services**, with
embedded web browsing in the desktop app and an optional headless Linux daemon.
Use **your own provider accounts** to talk by voice, practice languages, run local
commands and extend LILO with plugins for notes, focus sessions, music, weather and
more. The desktop app runs on Windows, macOS and Linux. No API key or local LLM/TTS
is required. LILO is free software; provider subscriptions, availability and voice
quotas still depend on your account.

Built with **Tauri v2 (Rust)** + **React 19 + TypeScript + Vite 7**. The shared
`lilo-core` crate also powers the headless Linux daemon. The daemon supports
standalone ChatGPT voice through its phone-managed browser and audio host; it
does not require a paired desktop. The desktop satellite remains a separate,
optional connection path. Standalone daemon voice currently supports ChatGPT;
other providers and plugin voice transports are not implied.

> LILO provides an independent interface with embedded web browsing for realtime voice services,
> signed in with your own account. It is an independent project, not affiliated
> with or endorsed by the providers. Availability and voice limits depend on
> your account and plan.
> Never commit or share your credentials.

---

## What it does

- **Realtime voice sessions** with barge-in, captions and a live transcript,
  through the providers' web voice paths, subject to their account limits.
- **Providers, one contract** — native ChatGPT, Claude and Grok adapters,
  plus installable provider plugins.
  Each is an adapter that declares what it can do; the app renders and routes
  from those declarations, never from a provider name. Plugins declare their transport and capabilities through the
  [provider plugin contract](docs/provider-plugins.md); vendor scripts stay in the plugin.
- **Headless Linux daemon** — run local commands and compatible plugins without
  Tauri, manage supported settings from a phone, use local media, and start
  standalone ChatGPT voice when the optional browser and audio host is configured.
  First-boot Wi-Fi setup has no physical hardware validation. The phone shell
  manages Wi-Fi after the daemon joins a network and delivers plugin interaction
  questions through voice. Other provider voice adapters are unsupported and
  board resource behavior is unverified.
  See [LILO on Linux hardware](docs/headless-linux.md) for the one-command
  installation, supported boards/computers, audio requirements and resource measurements.
- **Wake word** — say `"lilo"` to start talking, hands-free. Native helper
  on macOS and native WinRT recognizer on Windows/WebView2. Linux uses local
  PocketSphinx phrase detection; manual activation is available on every desktop
  OS. Spoken Linux device acceptance remains required.
- **Voice commands routed locally** — "stop the music", "make it rain", "turn
  off the background", "end the call" — matched in Rust, not by the model, so
  they work without a round trip. Destructive phrases ask first.
- **Application opening** — common app names work without installing a plugin
  or configuring paths: say `LILO, open VS Code`, `open Chrome`, or
  `open Teams`. LILO resolves the installed app locally on Windows, macOS,
  and Linux desktops. **Computer control** settings can disable opening.
  Ambiguous or missing apps produce an error; opening is reported as a launch
  request. File analysis and editing are not available yet.
- **Text entry (experimental, opt-in)** — install the **Desktop control**
  plugin to open installed applications and insert dictated text into supported
  fields on Windows, macOS and Linux desktops. Say `open my VS Code`
  or `in my VS Code write YOUR WORDS`, then `confirm` or `cancel` for
  text entry. OS permissions and field support apply; see the
  [plugin guide](docs/plugins.md).
- **Local media** — "play Walk by Pantera" resolves and plays through
  **mpv + yt-dlp**. LILO provisions pinned, verified binaries where the
  platform has a supported package; Linux uses an installed or configured mpv.
  Music ducks while the assistant talks, and its loudness drives the visualizer.
- **Plugins** — first-party weather and location, plus a **marketplace**: install
  a plugin from a repository, activate/deactivate it without losing its data,
  uninstall it clean; the development reads the local `examples/plugins` folder; release builds use the repository with a bundled offline fallback. Every
  plugin that declares settings, status or actions
  gets its own page in Settings. A plugin is **one JavaScript file** run in the
  host's embedded engine — the same file on Windows, macOS and Linux — or a
  process in any language when it needs the OS.
- **Background scenes** — the weather plugin paints the window from a fixed
  scene vocabulary (rain, snow, storm with forked lightning, fog, heat, cold),
  chosen by the real weather or previewed by hand.
- **LILO, the character** — a vector visualizer that reacts to speech, music,
  pointer movement and conversation, using your selected palette.
- **Sign in from the phone** — scan a QR code and answer on the phone what the
  PC's login page asks (e-mail or phone number, password, code); the PC keeps
  a session that renews itself. Accounts created only with Google or Apple
  need a password or phone number added first.
- Palettes, light/dark/system theme, voices and voice modes, and the
  assistant's reply language. The interface ships in **English, Portuguese and
  Italian**.
- **Provider-reported voice limits** — remaining minutes or daily retry times
  are shown for the selected account when the service supplies them.

## Hard constraints

- **Free software**: no API keys, paid API dependencies, local LLM or local TTS.
  Provider subscriptions and voice quotas apply separately.
- Small wake-word and STT models are allowed on headless targets only when they
  are OSS, keyless and measured to run comfortably on the board — see
  [`docs/command-protocol.md`](docs/command-protocol.md) §9.

## Install LILO

Download the installer for your OS from [GitHub Releases](https://github.com/swappcloud/lilo/releases). Desktop installations do not require Node, Rust or a source checkout. See [release instructions](docs/releases.md) for package formats, OS approval and updates.

For the Linux daemon on 64-bit Debian/Ubuntu-based systems:

```sh
curl -fsSL https://raw.githubusercontent.com/swappcloud/lilo/main/scripts/install-daemon.sh | sh -s -- --install-system-deps --lan
```

This command downloads the latest published release source, installs missing system
dependencies and builds/starts the container runtime. Git and a manual clone are
not required. The command becomes available when the repository and a release
containing the installer are public. See [Linux setup](docs/headless-linux.md)
for audio, phone pairing, HTTPS and service commands.

## Development requirements

- **Node 22** and **npm 10**
- **Rust stable** (`cargo`) — installed by the setup command when missing
- Platform WebView for Tauri v2 (WebView2 on Windows, WKWebView on macOS,
  WebKitGTK on Linux). On Windows the setup command also provides the C++
  toolchain — MSVC when it is already installed, otherwise a portable MinGW
  under `%LOCALAPPDATA%\lilo`, so **no administrator rights are needed** —
  and the WebView2 runtime if the machine lacks it.
- **macOS only**: Xcode command line tools (`swiftc`) to rebuild the wake-word
  helper: `xcode-select --install`, then `scripts/build-wake.sh`
- Linux source setup provisions wake libraries and the model on Debian/Ubuntu.
  Linux packages include wake assets; see the [wake architecture](docs/architecture.md#wake-word).

## Run from source

Clone [swappcloud/lilo](https://github.com/swappcloud/lilo) and enter the checkout.
One command installs everything the machine is missing — Rust,
on Windows the C++ toolchain and the WebView2 runtime — plus the npm
dependencies:

Windows (Command Prompt or PowerShell):

```text
.\scripts\setup.cmd
```

macOS / Linux:

```sh
sh scripts/setup.sh
```

With Node 22 already present, `npm run setup` does the same. `npm run dev`
also installs the locked npm dependencies automatically if a fresh checkout
does not have them yet. Then:

```bash
npm run dev  # builds Rust, starts Vite, opens the window
```

Then, in the app:

1. **Settings → Account → Sign in with ChatGPT** or another installed provider (the
   embedded window signs in normally; nothing to copy).
2. Pick the backend and its voice in **Settings → Provider**.
3. Say **"lilo"** — or click the orb / press `Space` — and talk.

Try: *"play Bohemian Rhapsody"*, *"how is the weather"*, *"make it rain"*,
*"turn off the background"*, *"end the call"*.

`npm run tauri:build` produces the bundled app. LILO provisions supported media
artifacts on demand; Linux uses system or configured mpv.

## Verification

```bash
npm run typecheck       # TypeScript
npm test                # Vitest and scripts/*.test.mjs
npm run build           # Vite production build
cargo test --workspace  # Rust (from the repo root)
```

The marketplace has a digest test: after changing anything under
`examples/plugins`, run `scripts/build-marketplace.sh` — a test fails when the
index and the files disagree.

## Project layout

```
crates/lilo-core/       headless core: commands, plugins, media, tools,
                        settings, storage, weather, location
src-tauri/              the desktop app: window, webview, SDP gateway, wake
                        helper, phone login, logging
  src/providers/        the backends in Rust: the web sign-in registry, each
                        backend's injected script, and the Claude voice
                        transport
  assets/               the engine script injected into claude.ai
app/                    the web app (Vite root)
  index.html            splash first paint + the app entry
  public/               favicon and static files
  src/                  React app
    app/                shell, splash/intro handoff, bootstrap
    features/           voice (LILO character, orb, barge-in), scene, media,
                        settings, transcript, conversations, commands
    providers/          voice backends: the contract plus one folder per
                        adapter (chatgpt, claude, mock) and the composition
                        root that installs them
    store/              Zustand: session, preferences, media, scene, plugins
    lib/                typed Tauri IPC, audio bus, music levels, i18n
    shared/             brand paths, UI primitives, hooks
examples/plugins/       hello, notes, pomodoro (one .js file each, quickjs)
                        (+ index.json: the bundled marketplace catalog)
scripts/                dev launcher, wake helper build, marketplace build
docs/                   architecture, command protocol, plugin contract
```

## Cross-platform

Windows, macOS and Linux are equally supported desktop platforms. Linux also
runs the daemon on compatible computers and boards. Platform-specific features
declare their availability; no OS or board is the primary target.

- Anything the app executes has a per-platform form: a plugin declares
  `entries` (`notes.sh` for macOS/Linux, `notes.ps1` for Windows, which the host
  starts through PowerShell), Rust uses `cfg(windows)` with a real fallback,
  and `scripts/` stays POSIX `sh` or Node — no bashisms.
- A plugin or feature that genuinely cannot exist on an OS says so with
  `platforms` and is skipped there; it never
  fails to start on that OS.
- Encodings are explicit where a platform defaults to a code page (the
  PowerShell plugins set UTF-8 in and out), and paths, env vars, signals and
  process control are never assumed.
- Verify with `cargo test --workspace`, `npm run typecheck`, `npm test` and
  `npm run build`; platform branches are kept small and unit-tested so the
  other OSes stay green.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit, and the
  flows behind them.
- [`docs/command-protocol.md`](docs/command-protocol.md) — the voice command
  protocol and the headless Linux device plan.
- [`docs/plugins.md`](docs/plugins.md) — the plugin contract and marketplace.
- [`docs/plugin-authoring.md`](docs/plugin-authoring.md) — JavaScript APIs, UI and language packs
- [`docs/chatgpt-voice-protocol.md`](docs/chatgpt-voice-protocol.md) and
  [`docs/claude-voice-protocol.md`](docs/claude-voice-protocol.md) — the web
  voice protocols LILO speaks.
- [`docs/atlas.md`](docs/atlas.md) — a file-by-file map of the code.

## Privacy

LILO stores account sessions, settings and local history on your device. Voice audio and shared context go to the provider you select. LILO does not automatically upload conversations or diagnostics to its maintainers. See [Privacy](PRIVACY.md) for details.

Desktop installers and manual GitHub Actions builds: [Release builds](docs/releases.md). Grok transport and app verification: [Grok web voice](docs/grok-voice-protocol.md).

## License

Copyright (C) 2026 LILO contributors.

LILO is free software licensed under [GPL-3.0-only](LICENSE). Third-party components retain their own licenses.
