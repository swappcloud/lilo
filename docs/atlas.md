# Atlas

Daemon additions: `crates/lilo-daemon/src/{broker,browser_login,voice,voice_session,media,device}.rs`
own private broker access, phone sign-in, voice lifecycle, caption routing, shared-media
hosting and device preferences. `app/src/providers/chatgpt/captionStream{,.test}.ts`
assembles streamed turns for both desktop and daemon without host dependencies.
`crates/lilo-core/src/persona.rs` builds the daemon's opening identity and language
instructions; `crates/lilo-daemon/src/interactions.rs` delivers plugin questions.
`crates/lilo-daemon/src/network.rs` owns the phone-managed Wi-Fi controller. `wake.rs` builds the local finite command grammar from the active registry; `voice_session.rs` drains recognized commands through the shared command router while idle, even without an account.
`app/src/features/daemon/VoicePanel.tsx` provides phone voice controls and captions;
`useDaemonVoice.ts` owns their shared session controller, and `VoiceSessionControl.tsx`
keeps session status and the stop action available in music and settings;
`DeviceSection.tsx` provides explicit audio checks. `packages/daemon-browser-host/src/voice_browser.ts`
hosts the ChatGPT WebRTC adapter; `voice_service.mjs` owns its lifecycle and lease.
`scripts/setup.{sh,cmd,mjs}` are the setup entry points. The daemon runtime image
bundles the compatible plugin catalog under `/opt/lilo/marketplace`.

A map of the tree for whoever works in it next — human or agent. Read this
first, open only the files it points at. The *why* lives in
[`architecture.md`](architecture.md); protocols in their own docs.

**Keep it current:** a change that adds, moves, splits or removes a module
updates its line here in the same change.

## Where is…

| Looking for | Go to |
|---|---|
| A Tauri command (`invoke`) | registered in `src-tauri/src/lib.rs` (`invoke_handler`); typed wrappers in `app/src/lib/gateway.ts` |
| Window style, companion ↔ classic, click-through, native menus | `src-tauri/src/shell.rs` (+ `statusbar.rs` for the tray) |
| What the companion draws | `app/src/features/companion/` + `app/src/styles/companion.css` |
| The classic window UI | `app/src/app/AppShell.tsx` |
| Session lifecycle, captions, ducking, command effects | `app/src/store/sessionStore.ts`; `captionPersistence.ts` coalesces streaming history saves outside the render path |
| ChatGPT realtime (WebRTC, DataChannel) | `app/src/providers/chatgpt/webVoiceProvider.ts`, `events.ts`, `dcProtocol.ts`; Rust `src-tauri/src/gateway.rs`, `providers/chatgpt.rs` |
| Claude voice | `app/src/providers/claude/webVoiceProvider.ts` (captions synced via `spokenText.ts`; voices/languages/speeds in `voiceCatalog.ts`), `providers/shared/pcmAudio.ts`; Rust `src-tauri/src/providers/claude_voice.rs` |
| Grok live voice | `app/src/providers/grok/{definition,webVoiceProvider,gateway}.ts*`; Rust `providers/{grok,grok_voice}.rs`; engines `src-tauri/assets/grok-{login,voice-engine}.js`; contract `docs/grok-voice-protocol.md` |
| Qwen web voice | `examples/plugins/provider-qwen/` (installable QuickJS provider); generic Rust browser/voice host; `docs/qwen-voice-protocol.md` |
| Sign-in windows | `src-tauri/src/providers/{mod,web_login,chatgpt,claude,grok}.rs` |
| Voice command matching | `crates/lilo-core/src/commands/{registry,matcher,router,manifest}.rs` |
| System prompt | `app/src/store/sessionPrompt.ts` + `commands/manifest.rs` |
| Language study and learning memory | `examples/plugins/study/{study.js,plugin.json}`; `docs/language-study.md`; `app/src/store/conversationEvents.ts` publishes opted-in caption evidence with first-observed times for the latest 512 turn ids; plugin `contextTool` is read through `plugins/registry.rs` |
| Plugins (load, run, UI, marketplace) | `crates/lilo-core/src/plugins/`; UI in `app/src/features/settings/Plugin*.tsx` |
| Writing JS plugins / adding interface languages | `docs/plugin-authoring.md`; `examples/plugins/language-es/`; `app/src/i18n/pluginLanguages.ts` (active language packs); `lib/pluginLocalization.ts` (plugin-owned display text); `scripts/export-translations.mjs` (author dictionary export) |
| Music (mpv, yt-dlp, queue, levels) | `crates/lilo-core/src/media/`; front `store/mediaStore.ts`, `lib/musicLevels.ts` |
| Wake word | `src-tauri/src/wake/` (one file per OS), Swift helper `src-tauri/wake/lilo-wake.swift`; front `features/voice/useWakeWord.ts`, `store/wakeStore.ts` |
| Screen capture / vision | plugin `examples/plugins/screen` (capture + macOS permission action) → host upload `src-tauri/src/gateway.rs::upload_image` → `lilo://screen` (`lib/gateway.ts`, `store/sessionStore.ts::relayImage`, `provider.sendImage`) |
| Generated pictures / gallery | request: plugin `imagine` result → `lib.rs` `lilo://imagine` → `store/imageRequests.ts`;  Grok card `generated_image_card` → `src-tauri/assets/grok-voice-engine.js` (fetch + parts) → `providers/grok/webVoiceProvider.ts` (`onImage`); ChatGPT `image_asset_pointer` → `providers/chatgpt/images.ts` → `src-tauri/src/providers/chatgpt_images.rs` (`gateway.rs::download_image`) → `providers/chatgpt/webVoiceProvider.ts` (`onImage`) → `store/generatedImages.ts` (thought bubble in `features/companion/CompanionShell.tsx`, `image.created` on the bus) → plugin `examples/plugins/gallery` → list `image` rows drawn via `plugins/images.rs` (`plugin_image`) |
| Music history / replay | `media/service.rs` publishes `media.playing` → plugin `examples/plugins/history` (live `ui.list`) → `play` result → `src-tauri/src/playback.rs` → `media_play` |
| Weather scene / location | `crates/lilo-core/src/{weather,location}.rs`; front `features/scene/`, `store/sceneStore.ts` |
| LILO's face / mood | `crates/lilo-core/src/mood.rs`; front `lilo/liloModel.ts` (brow + smile geometry), `store/moodStore.ts`; automatic from the conversation: `store/moodContext.ts` + `store/moodCues.ts` (keyword cues) |
| UI strings | `app/src/i18n/messages/<domain>.ts` (en/pt/it), merged in `messages/index.ts` |
| Preferences (theme, palette, language…) | `app/src/store/preferencesStore.ts` (`localStorage` `lilo/…`) |
| Persistent app data | Tauri app-data dir `com.lilo.app`; `shell.json` (companion flag + position), `accounts.json`, `settings.json`, `plugins/`, `bin/` |
| Logs | `.tmp/logs/lilo.log` in checkout; `src-tauri/src/logging.rs`, front `lib/log.ts`; `src-tauri/src/diagnostics.rs` exports approved fields from the menu and Settings |
| Headless Linux build and deployment | `crates/lilo-daemon/`, `docs/headless-linux.md` |

## Rust

### `crates/lilo-core` — headless core, never depends on `tauri`

| File | What it is |
|---|---|
| `lib.rs` | Module list |
| `accounts.rs` | Account store per provider, token metadata |
| `refresh.rs` | ChatGPT access-token refresh through HTTPS requests |
| `settings.rs` | Client identity headers, app settings |
| `storage.rs` | Disk usage and safe cleanup |
| `error.rs` | Shared error type |
| `tools.rs` | Built-in tools: time, web search, LILO's mood |
| `location.rs` | Where the user is (IP / device), published on the bus |
| `weather.rs` | Weather plugin: forecast → scene + mood |
| `mood.rs` | A spoken mood word → the expression LILO's face shows |
| `satellite.rs` | Satellite link protocol (PCM16 over TCP) |
| `commands/manifest.rs` | Command declarations → model manifest text |
| `commands/registry.rs` | Command registry, template parsing, finite local-recognition catalog |
| `commands/local.rs` | Versioned local transcript IPC schema and finite template expansion |
| `commands/matcher.rs` | O(n) utterance → intent matcher |
| `commands/router.rs` | Precedence, debouncing, confirm, effects |
| `media/player.rs` | mpv over JSON IPC, levels, watchdog |
| `media/resolver.rs` | yt-dlp resolution |
| `media/service.rs` | Shared media tools: search, selected-track playback, artwork, queue and volume |
| `media/provision.rs` | Pinned mpv/yt-dlp/Deno downloads with SHA-256 |
| `media/process.rs` | Quiet media children, bounded output, Windows process-tree ownership |
| `media/binaries.rs` | Locating binaries |
| `plugins/mod.rs` | Plugin host facade |
| `plugins/manifest.rs` | `plugin.json` schema |
| `plugins/loader.rs` | Discovery, `.disabled`, host/platform compatibility and retirement of replaced first-party plugins |
| `plugins/http.rs` | Generic permission-scoped HTTP bridge: exact domains, redirects, bounded UTF-8 requests/responses and timeout; no account/cookie inheritance |
| `plugins/quickjs.rs` | Embedded JS runtime (default), generic memory/scheduler bindings and scheduled owned-tool dispatch |
| `plugins/durable.rs` | Atomic versioned private JSON records, revision guards, bounded backup recovery and sanitized forgetting |
| `plugins/session.rs` | Validated public session context: local identity, language/state and protocol capabilities; no private account fields |
| `plugins/scheduler.rs` | Persistent owned-tool jobs, missed policies, cancellation, bounded claim/delivery history |
| `plugins/desktop/mod.rs` | Scoped desktop host API: capability checks, cached private installed-app catalog, refresh on lookup misses and sanitized results |
| `plugins/desktop/aliases.rs` | Built-in spoken names for common installed applications, independent of OS paths |
| `plugins/desktop/provider.rs` | Bundled Computer control tool provider: natural common-app opening, voice listing and optional disable switch |
| `plugins/desktop/{macos,windows,linux,unsupported}.rs` | Native application launch and field-specific text insertion; explicit headless/unsupported errors |
| `plugins/desktop/variant.rs` | Bounded GVariant value parsing and text escaping for Linux accessibility calls |
| `plugins/sidecar.rs` | Process runtime, JSON over stdio |
| `plugins/provider.rs` | The trait a tool owner implements (plugins, built-ins) |
| `plugins/registry.rs` | `ToolRegistry`: identity, routing |
| `plugins/bus.rs` | Retained topic event bus |
| `plugins/images.rs` | Pictures a plugin keeps in `data/`, read back as `data:` URLs for list rows |
| `plugins/store.rs` | Per-plugin settings |
| `plugins/ui.rs` | Bounded declarative settings, actions, lists, cards, progress and forms; static owned-tool validation |
| `plugins/marketplace.rs` | Index, verified install/update/uninstall |

### `crates/lilo-daemon` — LILO with no local window (Linux)

`main.rs` entry · `app.rs` stores, tools, plugins, commands · `config.rs` its
file · `setup.rs` + `setup.html` legacy first-setup flow (hardware validation
pending) · `wifi.rs` network/AP helpers (not exposed for ongoing phone
management) ·
`satellite.rs` Linux side of the paired audio link · `log.rs` console.

`management/mod.rs` typed request port · `management/service.rs` plugin/account
management use cases · `management/http.rs` opt-in authenticated LAN adapter.
`browser_login.rs` optional private browser adapter and confirmed account capture ·
`device.rs` persistent phone-managed language, command locales and wake phrase ·
`media.rs` adapter registering the shared core media service with daemon tools.
Shared mobile frontend: `app/daemon.html`, `features/daemon/`; build with
`vite.daemon.config.ts` into `.tmp/daemon-web`, independently of desktop.

### `src-tauri/src` — the desktop app

| File | What it is |
|---|---|
| `lib.rs` | App setup, `AppState`, every Tauri command, window events |
| `shell.rs` | Main window style (classic / companion), the panel window beside the companion, `shell.json`, click-through cursor poll, macOS app menu, `shell_*` commands, shared tray menu items |
| `statusbar.rs` | Tray icon on every OS: plugin actions + shell controls |
| `gateway.rs` | SDP gateway, session ↔ account bindings |
| `providers/mod.rs` | `WebBackend` registry, `provider_login*` |
| `providers/idle.rs` | Closes unused hidden provider transports after a two-minute grace; active voice and login windows stay open |
| `providers/web_identity.rs` | Bounded public profile decoding for cookie-owned providers; name/email only, credentials stay in the provider WebView |
| `providers/web_login.rs` | Embedded sign-in webview plumbing |
| `providers/chatgpt.rs` | ChatGPT sign-in + same-origin network bridge |
| `providers/chatgpt_history.rs` | Same-origin linked-chat branch refresh; bounded messages, no credentials returned to the main window |
| `providers/chatgpt_images.rs` | Downloads a picture ChatGPT made in the call (`chatgpt_generated_image`) |
| `providers/claude.rs` | Claude sign-in |
| `providers/phone_form.rs` | Phone sign-in for any web backend: the login page asks, the phone answers (e-mail or phone number, code, password); `packages/phone-login/observer.js` records submission counts and HTTP status without credential data |
| `providers/cloak.rs` | Phone login presentation: transparent + click-through on macOS, off-screen on Linux, visible on Windows to keep WebView2 rendering the form |
| `providers/claude_voice.rs` | Claude voice socket relay (inlined plugin) |
| `providers/grok.rs` | Grok web-session marker and desktop/phone login |
| `providers/grok_voice.rs` | Grok voice socket relay and restricted report plugin |
| `phonelogin.rs` | LAN phone login server + QR; serves `assets/phone-login.html` (app-styled, in the user's accent) — ChatGPT keeps a `/paste` fallback |
| `phone_network.rs` | LAN interface choices and a bounded local phone-server health check |
| `updater.rs` | GitHub release discovery, signed updater state, confirmation and install commands |
| `vision.rs` | Provider-neutral local screenshot relay; the active adapter owns any upload or video delivery |
| `image_export.rs` | Validated plugin pictures exported to Downloads without overwriting existing files |
| `playback.rs` | A tool result's `play: {track, artist}` starts that song through `media_play` |
| `wake/{mod,macos,windows,unsupported}.rs` | Wake engines per OS; macOS forwards helper transcripts, Windows adds finite registered command phrases |
| `audio.rs` | Optional native mic levels via `cpal` (`native-audio` feature) |
| `resources.rs` | Memory/CPU of the whole app (process panel) |
| `satellite.rs` | Driving a session without a microphone |
| `logging.rs` | Append-only log file and bounded export snapshot |
| `diagnostics.rs` | Approved-field sanitization and native file export (`export_logs`); no automatic upload |

Config: `tauri.conf.json` (main window `create: false`, built by `shell.rs`),
`capabilities/` (`panel.json` for the panel window), `binaries/LiloWake.app`, `icons/` (`tray-template.png`).

## Web app — `app/src`

### Entry and shells

| File | What it is |
|---|---|
| `main.tsx` | Boot: window role, shell style, preferences, then `App` or `PanelWindow` |
| `app/App.tsx` | Main window: runtime hooks, owner bridge, then `CompanionShell` or `AppShell` |
| `app/PanelWindow.tsx` | The panel window beside the companion: settings, conversations, transcript, commands |
| `app/windowRole.ts` | Main window or panel; `ownerCall` for functions that must run in the main window |
| `app/windowBridge.ts` | Owner ↔ panel: store mirror, remote actions and owner calls |
| `app/mirror.ts` | Store snapshot diff/patch the bridge sends |
| `app/useApplyPreferences.ts` | Theme, palette and animation flags on the document |
| `app/AppShell.tsx` | Classic window layout |
| `app/shellStyle.ts` | `useShellStyle` (companion/classic), `html[data-shell]` |
| `app/useAppRuntime.ts` | Wake, permissions, media polling, location, levels — both shells |
| `app/useMenuActions.ts` | Native menu → actions; `toggleSession` |
| `app/useShellState.ts` | Pushes flags + localized menu labels to Rust |
| `app/useBootstrap.ts` | One-time load + login events |
| `app/splash.ts` | Splash narration and glide to the stage |

### Features

- `companion/` — `CompanionShell` (bubble priority, opens the panel window),
  `CompanionMascot` (click/drag/right-click), `MediaRing` (+ volume/queue
  popovers), `geometry.ts` (window numbers, bubble side, hold time),
  `useSpeech`, `useHitRegions`, `usePointerHover` (hover from the Rust cursor watch), `usePresence`.
- `voice/` — `VoiceStage`, `ControlDock`, `ConfirmBar`, `StatusDot`, orb
  visualizer (`orbRenderer`, `useOrbVisualizer`, `OrbCanvas`), `useVoicePhase`,
  `useWakeWord`; `lilo/` the character (`liloModel` geometry, `liloRenderer`,
  `LiloStage`, gaze, intro handoff).
- `settings/` — `SettingsPanel` + `sections.tsx` grouped nav, one `*Section.tsx` per
  page, `PluginPage`, `PluginImageDownload` (native picture export and DOM tests), `DiagnosticsSection` + `diagnostics.ts` (shared owner-window log export), `PhoneLoginSheet`, `ProviderStatusBadge` (live validation status), `UpdateSection` and `UpdatePrompt` (signed update controls and confirmation).
- `transcript/`, `conversations/`, `commands/` — side panels.
- `media/MediaPlayer.tsx` (shared playback controls), `media/MusicSearch.tsx` (explicit song search, artwork and selected-track playback), `scene/` (canvas scene), `statusbar/StatusTimer`,
  `location/deviceLocation.ts`.

### Providers

`contract.ts` types + registry · `registry.ts` installs adapters ·
`types.ts` shared types · `chatgpt/`, `claude/`, `mock/` one folder each
(definition, transport, voice catalog, mark, Rust gateway) ·
`shared/pcmAudio.ts`.

### Stores (Zustand) — `store/`

`sessionStore` (the big one) · `sessionPrompt` · `hiddenTurns` · `pendingNotes` · `conversationPolicy` (continue vs. new conversation, the recap) ·
`commandEffects` · `confirmStore` · `mediaStore` · `sceneStore` · `moodStore` ·
`preferencesStore` · `language` · `wakeStore` · `alertStore` ·
`pluginsStore` / `pluginNotify` · `settingsDraft` · `statusbarStore` ·
`toastStore` · `updateStore` (native update events and automatic checks) · `generatedImages` (a picture the backend made: the thought bubble and `image.created`).

### Shared

`lib/pluginPresentation.ts` — plugin-owned localized names and descriptions, with fallback and unit tests.

`lib/gateway.ts` (IPC) · `lib/log.ts` · `lib/audioBus.ts`,
`lib/musicLevels.ts` (visibility-aware visual readings, stale-request guard), `lib/chime.ts` ·
`shared/lib/microphone.ts` (confirmed capture permission state) · `shared/lib/visibleRaf.ts` (shared native visibility watch, animation cadence) · `shared/ui/` (primitives, controls,
icons, Logo, Toast) · `shared/hooks/` · `shared/brand/logoPaths.ts` ·
`styles/` (`tokens`, `base`, `layout`, `ui`, `settings`, `player`, `lilo`, `companion`, all imported by `index.css`).

`lib/hostPort.ts` is the alternative-host operation port; native IPC remains
the desktop default. `features/daemon/daemonHost.ts` adapts it to the daemon
domain API; `DaemonShell.tsx` reuses the existing desktop plugin features.
`daemonBrowser.ts` encrypts phone login and device audio requests ·
`DeviceSection.tsx` offers device preferences and explicit audio tests ·
`settings/BrowserSignInSheet.tsx` renders a host-independent phone login flow;
`BrowserSignInSheet.test.tsx` checks field visibility, absence of normal-page
mirroring, working state and provider errors.

### Optional headless packages

`packages/phone-login/driver.js` is the real-provider-page form driver shared by
desktop WebViews and the on-demand Linux Chromium engine. `packages/daemon-browser-host/src/`
contains the browser adapter, encrypted session use cases, Linux audio adapter,
private HTTP server and the provider-owned ChatGPT declaration/capture adapter.
Its Dockerfile packages Chromium, Xvfb, Node and PulseAudio tools, with an optional
WebKitGTK/Python login fallback. `chromium_browser.mjs` owns the default private
process lifetime; `browser.mjs` and `native_webview.py` own the optional GTK path,
native input and rendering. `phone_flow.py` preserves the desktop answer
lifecycle; `phone_flow_test.py` checks submission, errors and timeout without a
browser. Provider capture scripts remain in provider
declarations. No renderer or virtual display starts until sign-in begins. The daemon Dockerfile
packages the Rust command host and built mobile assets. `scripts/daemon-runtime.mjs`
builds, starts, stops and checks isolated local runtimes and prepares offline images;
`daemon-runtime.test.mjs` and `daemon-browser.test.mjs` cover boundaries and privacy.

## Elsewhere

- `docs/` — architecture and command references: `architecture.md`, `command-protocol.md`; plugin guides: `plugins.md`, `plugin-authoring.md`, `provider-plugins.md`;
  voice references: `chatgpt-voice-protocol.md`, `claude-voice-protocol.md`, `grok-voice-protocol.md`, `qwen-voice-protocol.md`, `conversation-history.md`; platform guides: `daemon-phone-management.md`, `headless-linux.md`, `linux-validation.md`, `raspberry-pi.md`, `releases.md`;
  product notes: `language-study.md`, `design-system.md`, `tool-calling-plan.md` (proposed).
- `examples/plugins/` — `hello`, `history`, `gallery`, `notes`, `pomodoro`, `dictionary` (free English lookup and offline vocabulary), `study`, `language-es` (partial translation starter), `desktop` (opt-in app launch and literal dictation), `screen` + `index.json`
  (rebuild with `scripts/build-marketplace.sh`).
- `scripts/` — `dev.mjs`, `build.mjs`, `prepare-release.mjs`, `setup.mjs`, `build-wake.sh`, `ci-platform-tests.mjs` (selects native PR checks by changed paths),
  `build-marketplace.sh` (POSIX wrapper), `build-marketplace.mjs` (cross-platform catalog builder), `test-linux.sh`, `pi-sim.sh`; release CI: `release-plan.mjs` (shared version and target definitions),
  `nightly-release.mjs` / `nightly-release.test.mjs` (daily changed-main planning and disposable checkout versions), `release-test.mjs` (release-profile workspace tests and application binary privacy audit), `release-publish.mjs`, `update-artifacts.mjs` (signed payloads, build validation CLI and manifest merge), `changelog.mjs` (version-specific notes), `bump-version.mjs` (`npm run version:bump`),
  `check-version.mjs` (shared version validation before development and installer builds). Release notes live in `CHANGELOG.md`; update translations in `app/src/i18n/messages/updates.ts`.
- Tests sit next to their code (`*.test.ts`, Rust `#[cfg(test)]`); `app/src/testSetup.ts` sets React's DOM-test environment flag.
- `scripts/wsl-phone-access.ps1` — Windows-only, explicitly elevated WSL NAT
  forwarding for one daemon port, restricted to the selected LAN and its subnet.
- `scripts/export-translations.mjs` exports current English interface keys for plugin authors; `scripts/plugin-authoring.test.mjs` runs the documented notebook and checks the exporter. `i18n/pluginLanguages.test.ts` and `lib/pluginLocalization.test.ts` cover active language contributions, removal, fallback and display-only translation.
- `scripts/plugin-platform.test.mjs` — dictionary lookup, compatibility detection, explicit saves, offline continuity and failure behavior; generic QuickJS tests discover all bundled manifests without adding per-feature native tests.
- `scripts/study-plugin.test.mjs` — learning memory persistence, language isolation, bounded journal/context, learner control and spaced review; `store/conversationEvents.test.ts` covers caption coalescing, injected-turn exclusion and shutdown ordering.
- `scripts/desktop-plugin.test.mjs` — desktop plugin contract, scoped dispatch, private results and headless loading checks.
- `scripts/release-privacy.mjs` / `release-privacy.test.mjs` — anonymized compiler paths and installer privacy gate, validated before publishing artifacts.

- `.github/workflows/release-build.yml` — runs daily at 02:00 UTC, skips fully released unchanged main, shares one frontend build and publishes only after all native targets pass. Pushes and PRs do not trigger it; use the Actions tab for a manual run. Local builds and distribution checks: `docs/releases.md`.
- `src-tauri/capabilities/grok-voice.json` — the Grok webview may report voice events only.

Phone verification regression tests: `app/src/providers/shared/phoneChallenge.test.ts` exercises invisible widgets and visible interactive challenges from the shared injected form driver.

Native app context-menu regression test: `app/src/app/nativeContextMenu.test.ts` executes the early WebView initialization script from `src-tauri/src/shell.rs`, preserving the companion menu while suppressing browser actions.

Phone submission regression tests: `app/src/providers/shared/phoneDriver.test.ts` executes the complete injected form script against code, rejection, post-submit verification, and password-to-code DOM transitions.

- `LICENSE` — GPLv3 text; license grant in `README.md`. Included in desktop resources.

Diagnostic UI messages: `app/src/i18n/messages/diagnostics.ts` owns export controls, privacy text and settings group labels.
Audio permission regression tests: `app/src/shared/hooks/useMediaDevices.test.ts` covers successful capture without WebView2 devicechange and explicit permission revocation.

- `app/src/store/sessionIdle.ts` — Owner-window conversation inactivity watchdog; speech, captions and interface activity reset its configurable deadline. `sessionIdle.test.ts` covers deadlines, defaults and cleanup.
- `app/src/features/settings/ConversationSection.tsx` — Inactivity timeout setting (30 seconds by default, 0 disables).
- `app/src/i18n/messages/conversation.ts` — Conversation settings and automatic-close messages in English, Portuguese and Italian.

- `src-tauri/windows/installer-hooks.nsh` — Windows NSIS post-uninstall desktop refresh; preserves updater shortcut behavior.

- `examples/plugins/vocabulary-review/{review.js,plugin.json,README.md}` — offline vocabulary cues and self-reported recall, native memory and persistent daily local-time jobs, entirely JavaScript.

- `app/src/store/pluginSessionContext{,.test}.ts` — voice-owner public session snapshots, capability filtering and ordered publication; `sessionStore.pluginSessionId` matches the conversation-event call id.
- `examples/plugins/phrasebook/{phrasebook.js,plugin.json,README.md}` — offline Italian travel phrases with live support-language explanations and provider-capability guidance, using the generic session API.

- `crates/lilo-core/src/plugins/interactions.rs` — bounded provider-independent question manager, owned answers, explicit confirmation, correlation and expiry.
- `app/src/store/pluginInteractions{,.test}.ts` — voice-owner question submission and correlated adapter acknowledgments.
- `examples/plugins/study-routine/{routine.js,plugin.json,README.md}` — daily-time interview, separate confirmation and atomic routine storage; existing `study` also uses this generic API.

- `app/src/lib/copyText{,.test}.ts` — clipboard copy with a restricted-WebView fallback; plugin list rows expose copy/edit/delete controls.

- `app/src/features/settings/PluginPage.tsx` — overview/library/preferences tabs, responsive saved-item grids, bounded forms and stable-ID text-row CRUD/copy; `pluginForm.test.ts` tests form bounds. `PluginDashboard{,.test}.tsx` validates and renders bounded chart data with accessible value tables.
- `app/src/lib/pluginLocalization{,.test}.ts` — display-only locale mapping for plugin UI descriptors and dynamic rows.

- `crates/lilo-core/src/plugins/registry.rs` — serializable plugin views include the running provider's owned tool names, used to filter dynamic list actions in the UI.

- `scripts/study-progress.test.mjs` — repeated oral-task evidence, audio-only skill gates, CEFR-inspired coverage, SM-2 retention, caption retractions and daily totals. `scripts/notes-plugin.test.mjs` — live notebook CRUD, duplicate IDs, stale-edit guards, legacy/native storage migration and recovery purging.
- `app/src/features/commands/CommandsPanel.tsx` — responsive command-card library, accent-insensitive search, plugin categories and expandable examples; `CommandsPanel.test.ts` covers discovery and filtering.
- `app/src/features/settings/SettingsPanel.tsx` — searchable category overview and grouped navigation. `PluginsSection{,.test}.tsx` owns the installed/catalog card grids, adjacent update action and updates-only filter. Desktop minimum is 1024 × 700 logical pixels in `src-tauri/tauri.conf.json` and `src-tauri/src/shell.rs`; native commands open at 1040 × 720 and fit the monitor.

- `app/src/shared/lib/searchText.ts` — shared accent-insensitive, multi-term search for settings and the voice-command library.
- `app/src/features/settings/SettingsPanel.test.tsx` — fixed search versus scrollable category groups and overview navigation. `ProcessSection{,.test}.tsx` — compact resource tiles, bounded CPU history, expandable diagnostics and retry-safe polling.
- `app/src/styles/tokens.css` — shared 4/8/12/16/24/32 px spacing scale; settings and command layouts consume the tokens. `app/src/shared/ui/controls{,.test}.tsx` — slider current values, units, bounds and linked explanations.

- `docs/conversation-history.md` — durable chat ids versus voice calls, provider-owned context, explicit rollover and sync limits; provider parser/history tests live beside adapters, `store/conversationHistory.test.ts` covers branch merging, `store/sessionConnect.test.ts` covers thread ownership and capacity rollover.
- `features/settings/ToolsSection.tsx` — aligned quick-action cards, searchable tool catalog and separate execution history; explanatory plugin status rows render prose in `PluginPage.tsx` rather than multiline uppercase chips.

- `scripts/conversation-history.test.mjs` — executes the complete injected history reader against branch, UTF-8, cycle, payload-budget and refresh-failure fixtures.

- `shared/ui/CardHeader.tsx` and `StatusBadge.tsx` — shared card header/status slots used by installed/catalog plugins and provider/account sections; `docs/design-system.md` defines layout, spacing, status and media-preview rules. Image list rows in `PluginPage.tsx` use a side-by-side preview/description layout.

- `shared/ui/ContentSkeleton.tsx` — accessible reserved-space loading states for asynchronous settings; `features/settings/PluginLoading.test.tsx` verifies loading versus empty states and page continuity during plugin updates.

- `examples/plugins/stories/` / `scripts/stories-plugin.test.mjs` — explicit child-friendly narration, bedtime pacing, bounded local endings, next-day chapters and story shelf CRUD. Study and stories coordinate through source-validated `activity.started` events.

- `app/src/shared/ui/primitives.drag.test.tsx` — native panel dragging stays in the header, away from scrollbars and controls. `app/src/features/transcript/TranscriptPanel.test.tsx` — live captions respect manual scrolling and resume following at the bottom.

- `app/src/features/settings/PluginActions.test.tsx` — editable list values and ordered voice context delivery for explicit plugin actions.

- `docs/qwen-voice-protocol.md` — observed web transport, supported capabilities and live-account validation checklist.


- `app/src/providers/chatgpt/webVoiceProvider.image.test.ts` — session-bound screenshot uploads and stale-session delivery protection.

- `app/src/store/providerLimits{,.test}.ts` — per-provider, account-scoped voice quota reports in memory; expiry based only on reported retry times.
- `app/src/features/voice/ProviderLimitNotice.tsx` — shared localized quota notice for controls and provider settings.

- `app/src/store/conversationScope{,.test}.ts` — provider-owned history selection; legacy mixed histories stay readable but are not injected into new sessions.

- `crates/lilo-core/src/plugins/{voice,browser}.rs` — bounded private provider lifecycle/output and optional browser port; no Tauri dependency.
- `app/src/providers/plugins/{types,registry,transport}.ts` — dynamic provider declarations, registry lifecycle and host-owned PCM/WebRTC media; adjacent tests cover removal and session isolation.
- `src-tauri/src/plugin_browser.rs` — plugin-owned browser profiles, declared-origin scripts, generic desktop sign-in and bounded private callback delivery.
- `examples/plugins/provider-qwen/{plugin.json,provider.js}` / `scripts/provider-plugin.test.mjs` — Qwen protocol implemented in QuickJS, isolated own-account login, remote `txt` channel, plugin-owned voice catalog, spoken captions and structured quota.
- `docs/provider-plugins.md`, `PRIVACY.md`, `docs/raspberry-pi.md` — provider extension contract, data handling notice and current headless validation limits.

- `scripts/test.mjs` — cross-platform test runner: Vitest followed by all `scripts/*.test.mjs`, with failure propagation.

- `app/src/store/providerLogin.test.ts` — explicit login selection versus background account refresh and late provider events.

- `app/src/providers/registry.test.ts` — bundled registry excludes Qwen until its external provider plugin is installed.

- Marketplace source selection: `crates/lilo-core/src/settings.rs::marketplace_sources` and `src-tauri/src/lib.rs::marketplace_index` — local `examples/plugins` only in desktop development; configured/repository sources with bundled fallback in release builds.

- Command help language: `commands/registry.rs::manifest_in` selects examples in the requested locale (English fallback); `CommandsPanel.tsx` and `ConfirmBar.tsx` request the interface locale explicitly.

- Plugin phone sign-in: `plugins/browser.rs::PhoneFormSpec`, `plugin_browser.rs::phone_config`, shared `providers/phone_form.rs` and `phonelogin.rs`; Qwen declares vendor selectors in `examples/plugins/provider-qwen/provider.js`, with no native Qwen adapter.

- `scripts/phone-login.test.mjs` — phone-page completion timer, polling shutdown and localized fallback when the mobile browser blocks tab closure.

- `scripts/daemon-resources.mjs` samples CPU, memory working-set and task counts for the local Docker daemon/browser runtime without accessing private session data.

- `hardware/lilo-device-concept/` is the isolated physical-enclosure study: concept render, interactive geometry, exported GLB and component/layout boundaries. `scripts/build-device-concept.mjs` assembles canonical brand geometry; `scripts/preview-device-concept.mjs` serves its local-only preview. None is part of the daemon runtime.

- `hardware/lilo-device-concept/desktop-character.ts` obtains a deterministic still from the desktop `LiloModel`; the design builder emits `companion.svg` for the circular device display without creating another character implementation.

- `scripts/install-daemon.sh` downloads a public release without Git, keeps runtime data across versions and delegates Linux provisioning.
- `scripts/install-headless.sh` installs and starts the packaged Linux runtime, with explicit dependency and LAN options; `daemon-runtime.test.mjs` verifies installer/runtime boundaries.
- `docs/linux-validation.md` records Linux build and resource evidence separately from the generic user setup guide.
- `hardware/lilo-device-concept/cad/enclosure.scad` and `ASSEMBLY.md` define the adjustable eight-design snap-fit circular enclosure, hardware selection and self-assembly procedure. `scripts/export-device-stl.mjs` exports individual print meshes; `parts/` contains the generated STL snapshot used by the design viewer.

- `.dockerignore` excludes private runtime profiles, pairing files, environment files and build directories from container build contexts; only generated daemon frontend assets are allowed from `.tmp/`.
- `scripts/device-kit.test.mjs` checks closed STL topology, solid volumes and the reference print envelope.

- Device design support: `hardware/lilo-device-concept/kit.mjs` owns printable part names and reference assets; `electronics.js` supplies component reconstructions; `COMPONENTS.md` records component selection; `cad/import_components.py` verifies manufacturer revisions and `cad/simplify_mesh.py` bounds presentation-only mesh complexity for the AMOLED/audio reference meshes in `components/`. `cad/requirements.txt` pins the export toolchain. These are design-workstation files, separate from daemon runtime.

- `crates/lilo-core/src/wake/{mod,linux}.rs` — Linux keyword engine, scoped dictionary, bounded PCM capture and failure events; no Tauri dependency.
- `src-tauri/src/wake/linux.rs` and `crates/lilo-daemon/src/wake.rs` — desktop event adapter and daemon wake lifecycle/idle activation.
- `scripts/prepare-linux-wake.mjs` / `linux-wake.test.mjs` — Linux model/library packaging, AppImage dependency files and redistribution notices.
- `app/src/lib/browserCrypto{,.test}.ts` — authenticated packets on HTTPS or trusted LAN HTTP, with WebCrypto and a noble AES-GCM fallback.
