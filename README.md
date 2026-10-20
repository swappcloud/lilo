# LILO — Listen In. Listen Out.

[![Release](https://github.com/swappcloud/lilo/actions/workflows/release-build.yml/badge.svg?branch=main)](https://github.com/swappcloud/lilo/actions/workflows/release-build.yml)

<p align="center">
  <img src="docs/media/lilo.gif" width="300" alt="LILO wakes up, looks around, listens and answers">
</p>

<p align="center">
  <a href="https://lilo.swappscloud.com"><strong>lilo.swappscloud.com</strong></a>
</p>

LILO is a free, independent voice interface for realtime services. The desktop
app combines voice conversations with embedded web browsing, and an optional
headless Linux daemon supports local commands and compatible plugins. Sign in
with your own provider accounts to practice languages, take notes, focus, play
music, check the weather, and more.

LILO runs on Windows, macOS, and Linux. It is built with Tauri v2, Rust, React
19, TypeScript, and Vite 7. The daemon shares the `lilo-core` crate and can run
standalone ChatGPT voice through an optional browser and audio host managed from
a phone. A paired desktop satellite remains another option. Standalone daemon
voice currently supports ChatGPT; other providers may have desktop voice
adapters or plugins.

LILO is an independent project and is not affiliated with or endorsed by the
providers. Provider availability, subscriptions, and voice quotas depend on
your own account. Never commit or share account credentials.

## What LILO does

- **Realtime voice:** Talk through supported providers' web voice paths, with
  captions, conversation history, and barge-in where the provider supports it.
- **Providers and plugins:** Use the built-in ChatGPT, Claude, and Grok adapters,
  or install provider and feature plugins. Each adapter declares its
  capabilities through a shared contract.
- **Headless Linux daemon:** Run local commands and compatible plugins without
  Tauri, manage supported settings from a phone, and use local media. The
  optional browser and audio host can start standalone ChatGPT voice.
- **Wake word:** Say `lilo` to start a session. macOS uses a native helper,
  Windows uses WinRT speech recognition, and Linux uses local PocketSphinx
  recognition. Manual activation is available on every desktop platform.
- **Local voice commands:** Commands such as “stop music” and “end the call” are
  matched locally in Rust. Destructive actions ask for confirmation.
- **Desktop control:** Open installed applications by name. The optional,
  experimental Desktop control plugin can enter dictated text into supported
  fields after confirmation.
- **Local media:** Play music through mpv and yt-dlp. LILO provisions pinned,
  verified tools where supported; Linux uses an installed or configured mpv.
- **Marketplace:** Install, update, disable, and remove plugins. Plugins run in
  the embedded JavaScript engine by default, or as a process when needed.
- **Visual experience:** Weather scenes and the LILO character respond to the
  conversation, music, and selected color palette.
- **Phone sign-in:** Scan a QR code and answer the provider's login prompts on
  your phone. The desktop keeps the resulting session and renews it normally.
- **Settings:** Choose palettes, light/dark/system themes, voices, voice modes,
  and the assistant's reply language. The interface is available in English,
  Portuguese, and Italian.
- **Provider voice limits:** Show remaining minutes or retry times when a
  provider reports them.

## Hard constraints

- LILO is free software. It uses no API keys, paid API dependencies, local LLMs,
  or local TTS.
- Small wake-word and speech-recognition models are allowed on headless targets
  only when they are open source, keyless, and measured to run comfortably on
  the intended hardware.
- Provider accounts, plans, availability, and quotas remain separate and are
  controlled by the user.

## Install LILO

Download a desktop installer for your operating system from
[GitHub Releases](https://github.com/swappcloud/lilo/releases). A desktop
installation does not require Node, Rust, or a source checkout. See the
[release instructions](docs/releases.md) for package formats, OS approval, and
updates.

To install the Linux daemon on a 64-bit Debian/Ubuntu-based system:

```sh
curl -fsSL https://raw.githubusercontent.com/swappcloud/lilo/main/scripts/install-daemon.sh | sh -s -- --install-system-deps --lan
```

The installer downloads the latest published source, installs required system
dependencies, and builds and starts the daemon runtime. See [LILO on Linux
hardware](docs/headless-linux.md) for supported devices, audio requirements,
phone pairing, and resource measurements.

## Development requirements

- Node 22 and npm 10.
- Rust stable (`cargo`). The setup scripts install it if needed.
- A Tauri v2 WebView: WebView2 on Windows, WKWebView on macOS, or WebKitGTK on
  Linux.
- Windows setup installs the required C++ toolchain. It uses MSVC when
  available, or a portable MinGW toolchain under `%LOCALAPPDATA%\lilo` without
  requiring administrator rights. The WebView2 runtime is also installed when
  missing.
- macOS only: Xcode command line tools (`swiftc`) are needed to rebuild the
  wake-word helper. Install them with `xcode-select --install`.
- Linux source setup provisions wake-word libraries and models on
  Debian/Ubuntu. See the [wake architecture](docs/architecture.md#wake-word).

## Run from source

Clone [swappcloud/lilo](https://github.com/swappcloud/lilo) and enter the
checkout. The setup command installs missing system tools and npm dependencies.

Windows (Command Prompt or PowerShell):

```text
.\scripts\setup.cmd
```

macOS or Linux:

```sh
sh scripts/setup.sh
```

With Node 22 already installed, `npm run setup` performs the same setup.
`npm run dev` also installs the locked npm dependencies when a fresh checkout
does not have them yet. Then run:

```sh
npm run dev
```

The app builds Rust, starts Vite, and opens the desktop window. In LILO, sign in
under **Settings → Account**, choose a voice under **Settings → Provider**, then
say “lilo” or click the orb. Try “play Bohemian Rhapsody,” “how is the weather,”
“make it rain,” or “end the call.”

Build a desktop installer with:

```sh
npm run tauri:build
```

## Verification

Run these checks from the repository root before submitting a change:

```sh
npm run typecheck       # TypeScript
npm test                # Vitest and scripts/*.test.mjs
npm run build           # Vite production build
cargo fmt --all -- --check
cargo test --workspace  # Rust
```

Every pull request to `main` runs the shared checks. Windows MSVC and Intel Mac
release profile tests run when a change touches files that affect that platform.
Releases build and publish after a pull request is merged to `main`. If you
change files under `examples/plugins`, also run `scripts/build-marketplace.sh`;
a test checks that the index matches the plugin files.

## Project layout

| Path | Purpose |
| --- | --- |
| `crates/lilo-core/` | Headless core: commands, plugins, media, tools, settings, storage, weather, and location. |
| `crates/lilo-daemon/` | Linux daemon and phone-managed settings, networking, and browser voice host. |
| `src-tauri/` | Desktop host: windows, WebViews, provider sign-in, voice gateway, wake helpers, and logging. |
| `app/` | React application and Vite entry points. |
| `app/src/providers/` | Provider contract, registry, and one adapter per provider. |
| `app/src/features/` | Voice, LILO character, media, settings, scenes, commands, and daemon UI. |
| `app/src/store/` | Zustand session, preferences, media, scenes, plugins, and related state. |
| `examples/plugins/` | Example QuickJS plugins and plugin documentation. |
| `scripts/` | Setup, development, build, release, and marketplace tools. |
| `docs/` | Architecture, protocols, platform guidance, and file map. |

Start with [`docs/atlas.md`](docs/atlas.md) for the file-by-file map.

## Cross-platform support

Windows, macOS, and Linux are equally supported desktop platforms. Linux also
runs the daemon on compatible computers and boards. Platform-specific features
declare their availability; no operating system or board is the primary target.

Anything the app executes needs a per-platform form. Plugins declare platform
entries or supported platforms, Rust uses `cfg` branches with real fallbacks,
and scripts use POSIX `sh` or Node rather than assuming a shell. Paths,
environment variables, encodings, signals, and process control are handled
explicitly for each platform.

## Documentation

- [Architecture](docs/architecture.md) — how the components and data flows fit
  together.
- [Command protocol](docs/command-protocol.md) — voice commands and the headless
  Linux device plan.
- [Plugins](docs/plugins.md) and [plugin authoring](docs/plugin-authoring.md) —
  plugin contracts, JavaScript APIs, UI, and language packs.
- [Provider plugins](docs/provider-plugins.md) — the provider adapter contract.
- [ChatGPT voice](docs/chatgpt-voice-protocol.md),
  [Claude voice](docs/claude-voice-protocol.md), and
  [Grok voice](docs/grok-voice-protocol.md) — supported web voice protocols.
- [Headless Linux](docs/headless-linux.md) — daemon installation and supported
  hardware.
- [Release builds](docs/releases.md) — package formats, signing, and updates.
- [File map](docs/atlas.md) — where to find code by responsibility.

## Privacy

LILO stores account sessions, settings, and local history on the device. Voice
audio and shared context go to the provider you select. LILO does not
automatically upload conversations or diagnostics to its maintainers. See the
[Privacy Policy](PRIVACY.md) for details.

## License

Copyright © 2026 LILO contributors. LILO is free software licensed under
[GPL-3.0-only](LICENSE). Third-party components retain their own licenses.
