# LILO — Command Protocol & Architecture

Scope: a generic, provider-agnostic protocol for commands usable **during a
conversation**, shared by every provider — and by a headless Linux device with
no provider at all.

This document is the source of truth for *how the protocol works*. Code
follows the document, not the other way around. The file-by-file map is
[`atlas.md`](atlas.md).

## 1. Goals and principles

1. **Generic core, specific adapters.** No provider wire format
   (`relay_message`, `chat_message_delta`, …) may appear in the core. All
   provider differences live behind an adapter.
2. **Capability-based.** The core never branches on a provider *name*; it
   branches on declared **capabilities** (does this provider deliver user text?
   assistant text? native tool calls? can it accept a system prompt?).
3. **Deterministic first.** Rule-matched commands take precedence over NLU and
   over the model. If a command is matched, it is executed; the model is not
   asked to "answer" a command.
4. **One source of truth.** Tools are defined once (Rust) and surfaced to the
   model, the UI and the command router through a single serializable manifest.
5. **No paid API dependencies.** No API keys, paid API services, local LLMs or
   local TTS (`AGENTS.md`). Provider accounts may have subscription requirements
   or usage limits; LILO does not grant free or unrestricted service access.
6. **Reversible first.** Destructive commands require confirmation.
7. **The core is Rust.** The target is a headless Linux device running headless,
   voice-only, with no usable WebView — so the protocol lives in
   `crates/lilo-core`, which must never depend on `tauri`, and the React app
   is a thin client that forwards captions and applies effects.
8. **Effects are data.** The router returns a list of `Effect` values and
   never calls the UI: the same outcome draws a toast on the desktop and rings
   a chime on a headless device with an available audio backend.

---

## 2. Conceptual model

### 2.1 Normalized inbound event

```ts
type AgentEvent =
  | { kind: "caption"; source: "user" | "assistant"; text: string; final: boolean; id?: string }
  | { kind: "state"; state: "speaking" | "listening" | "idle" }
  | { kind: "usage"; remainingSeconds?: number }
  | { kind: "error"; message: string }
  | { kind: "tool-call"; name: string; args: unknown; callId: string }   // assistant-driven
  | { kind: "raw"; provider: string; payload: unknown };
```

Captions are the only event kind the core needs to route commands. All other
kinds map to existing behaviours (barge-in, usage, errors, reconnect).

### 2.2 Command descriptor (single manifest)

```ts
type CommandScope = "app" | "session" | "tool" | "prompt";

interface CommandDescriptor {
  name: string;                 // stable id, e.g. "end-call", "web.search"
  scope: CommandScope;
  aliases: Record<string, string[]>;  // locale -> phrases ("en": ["close lilo", "stop lilo"])
  params?: JSONSchema;          // slot schema (tools reuse ToolDescriptor.parameters)
  requiresConfirm?: boolean;
  handler: (ctx: CommandContext, args: Record<string, unknown>) => Promise<CommandResult>;
}
```

The descriptor list is serializable: it is the **same manifest** used to build
the model prompt, the settings UI, and the router.

### 2.2b Effects

The router never touches the UI. It returns:

```rust
enum Effect {
    Interrupt,                       // barge-in: stop the assistant
    EndCall,
    SetMuted { muted: bool },
    SendHidden { text: String },     // status note for the model
    SystemTurn { text: String },     // transcript line
    Toast { text: String },
    Earcon { cue: Cue },             // for a host with no screen
}
```

The desktop implements `CommandHost` (`app/src/store/commandEffects.ts`); the Linux
daemon implements the same contract with chimes instead of visual toasts.

### 2.3 Provider capabilities and adapter

```ts
interface ProviderCapabilities {
  inbound:  { userText: boolean; assistantText: boolean; nativeToolCalls: boolean };
  outbound: { text: boolean; stopSpeaking: boolean; systemPrompt: boolean; toolResult: boolean };
  engine: "webrtc-dc" | "sdk" | "mock";
}

interface ProviderAdapter {
  id: string;
  capabilities: ProviderCapabilities;
  connect(options: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  sendText(text: string, options?: { hidden?: boolean }): void;
  interrupt(): void;
  parseInbound(raw: unknown): AgentEvent[];          // replaces direct use of events.ts
  encodeOutbound(command: OutboundCommand): unknown; // replaces dcProtocol.ts
  injectPersona(text: string, options: { hidden: true }): void;
}
```

`ProviderCapabilities` is what makes the core generic: the router enables the
assistant-driven path only when `nativeToolCalls` (or a safe textual bridge) is
available, and enables persona injection only when `systemPrompt` is available.

---

## 3. Data flow

```
inbound wire ──(ProviderAdapter.parseInbound)──> AgentEvent[]
                                                     │
                      ┌──────────────────────────────┴───────────────┐
                      ▼                                              ▼
              CaptionRouter (core)                          StateRouter (barge-in/usage)
          detect commands in user/assistant text              unchanged behaviour
                      │
              IntentResolver (aliases + fuzzy + slots)
                      │
              CommandRouter (precedence + confirmation)
                      │
     ┌────────────────┼─────────────────────┬───────────────────┐
     ▼                ▼                     ▼                   ▼
 scope=app      scope=session           scope=tool          scope=prompt
 (UI/state)   (mute/end/switch)     run_tool (Rust)     sendText -> model
                                          │
                                  result -> AgentEvent(tool-result)
                                          │
                        feedback (system turn + optional spoken summary)
```

---

## 4. Command protocol (grammar)

**Normalization** (`crates/lilo-core/src/commands/matcher.rs`): lowercase, fold
accents through a 20-entry table (`música` -> `musica`), drop punctuation,
collapse whitespace. The Rust matcher owns normalization for every host.

**Template language.** Deliberately hand-rolled rather than `regex`: matching
runs on every caption delta, `regex` costs ~1 MB of binary, and a token machine
keeps caption matching predictable across supported languages.

| Form | Meaning |
|---|---|
| `play` | a literal word |
| `[the\|a]` | optional group — matching one alternative is free, skipping it is allowed |
| `(by\|from)` | **required** alternative — exactly one must match |
| `{track}` | free-text slot, one or more tokens |
| `{!text}` | literal caption slot: preserve case, punctuation and accents in the captured tool argument |
| `<name>` | the assistant's name, substituted from the wake phrase before compiling |

A separator between free-text slots must be required. For example,
`play {track} (by|from) {artist}` distinguishes the song title from the artist.
Use a separate `play {track}` template for requests without an artist.

**Slot greediness.** A trailing slot takes the rest of the utterance; a middle
slot prefers the longest capture that leaves a valid separator and trailing
slot, within its bounded lookahead. A preposition inside a song title stays
part of that title rather than becoming the artist separator. Matching also
folds uppercase accents and ignores combining accent marks, so composed and
decomposed text behave alike.

**Matching pipeline.** Exact matching runs first across *every* command; fuzzy
(bounded Levenshtein, distance 0 for words of 3 characters or fewer) is only
consulted when nothing matched exactly, so a near-miss can never outrank a real
match.

**Precedence.** Most **specific** wins, where specificity is the number of
literal tokens consumed. Scope (`app`/`session` > `tool` > `prompt`) only breaks
a tie, then registry order. This ordering is what makes "stop the music lilo"
stop the music rather than hang up: the media pattern consumes more literals.

**Partial captions.** Captions stream as growing deltas
(`play` -> `play bohemian` -> `play bohemian rhapsody`), and the web path often
omits `final`. So:

* a command with **no free-text slot** fires immediately;
* a command **with** a free-text slot fires on `final`, or after
  `SLOT_SETTLE_MS` (900 ms) without the caption changing — whichever comes
  first. Identical redeliveries do not restart the timer, or it would never
  settle.

**Idempotence.** A command fires once per turn id, plus a `COOLDOWN_MS` (2.5 s)
per command across turns.

**Confirmation.** `requires_confirm` parks a command until the user confirms.
Plugin commands use it for destructive operations and text entry.

## 4.1 Local command recognition

When the wake listener is enabled, the desktop can route a recognized local transcript through the same Rust command router and tool host without connecting a provider. The versioned `local-voice-transcript` payload contains only caller-owned transcript text, a bounded turn id, and a final flag; it never accepts a tool name or execution request. Invalid versions, unknown fields, empty text, and oversized values are rejected. Raw local speech is not written to command logs.

The finite phrase catalog is derived from registered command templates, including plugin tools, so hosts do not maintain a second command list. Optional groups and alternatives expand within a fixed phrase budget. Prompt-only intents are excluded before router state changes. Commands that require confirmation continue through the existing confirmation flow, and free-text slots use the router's existing final/settle policy when the recognizer can provide dictation. A finite phrase-list recognizer can recognize literal command phrases, but it does not gain arbitrary slot dictation from this catalog.

Windows uses its installed WinRT speech recognizer with the configured wake phrase and finite English command phrases. macOS forwards the existing helper's transcript updates; its on-device transcription remains controlled by the user's wake-listener switch. A direct command such as “stop the music” works while listening; saying the wake phrase first follows the normal wake path and may start a provider session.

## 5. Model bridge (assistant-driven commands)

This is the critical design decision and must be capability-gated.

- On the **ChatGPT web voice** path there is **no tool-calling** and
  `client_tools` is ignored in the web adapter. A prompt-based marker protocol
  (instructing the model to emit e.g. `⟦lilo:call {…}⟧`) is **unsafe**: the
  assistant's text is synthesized to **audio** by the server, so the marker
  would be spoken aloud.
- Therefore the **primary, supported path is user-driven**: the user speaks a
  command, LILO executes it locally (`app`/`session`) or via a tool, and the
  model narrates the result. This is provider-generic.
- The **assistant-driven path** is enabled automatically by capabilities:
  a provider that exposes `inbound.nativeToolCalls` (or a text-only channel with
  no TTS) plugs into the same registry via `AgentEvent{tool-call}` and
  `outbound.toolResult`.

The tool **manifest** is advertised to the model by injecting it into the
existing hidden persona message in the session store when
`capabilities.outbound.systemPrompt` is true.

---

## 6. Media and app backends

Media is the first real command, and the shape it uses is the shape any future
app backend uses: the router only ever emits a **tool name and JSON args**.
Nothing in the command layer knows what YouTube is.

```
Resolver  (query -> tracks)          Player  (tracks -> sound)
  YtDlp { bin }    supported desktop and daemon hosts
  Http  { base }   configured fallback / headless Linux
                                      Mpv    IPC socket / named pipe
```

* `Resolver::YtDlp` uses `yt-dlp` to search and resolve YouTube results. It is
  robust, but process startup and stream resolution can be slow on constrained
  devices; measure the target hardware rather than assuming a board budget.
* `Resolver::Http` makes one call to a Piped-compatible instance and a second
  to `/streams/{id}`, handing mpv a **direct audio URL**. That matters: with a
  watch-page URL mpv would fall back to its ytdl hook and need yt-dlp anyway,
  which defeats the point. It also picks the cheapest stream at or above
  96 kbps rather than the best one.
* `auto` prefers yt-dlp when installed and degrades to HTTP, so a missing
  binary never turns into a failed command.

Dispatch is an **enum, not `dyn Resolver`**: it keeps `async-trait` out of the
crate and enum dispatch is cheaper on ARM. Adding Spotify or Alexa later is a
new variant plus its parser — the router, the registry and the UI are untouched.

mpv runs with `--no-video --cache=yes --demuxer-max-bytes=8MiB
--ytdl-format=bestaudio[abr<=?128]/…`. These options bound selected media
buffers; they are not a peak-memory budget or evidence of support for a board
with a particular amount of RAM. It is driven over line-delimited JSON IPC (a
unix socket, a named pipe on Windows). `MpvPlayer` implements `Drop`, and host
shutdown stops it synchronously.

**Ducking.** While the assistant speaks, volume drops to `duck_percent` of the
current level and is restored after. Without it the music and the assistant
talk over each other.

**Binary discovery.** A GUI app launched from Finder inherits a minimal `PATH`,
so `/opt/homebrew/bin` is invisible and a plain lookup fails in the packaged app
while working in a terminal. `binaries.rs` probes `PATH` plus an explicit
candidate list, with a settings override. Spawning through
`std::process::Command` needs **no** Tauri ACL entry — `capabilities/default.json`
grants no `shell:*`, and `wake/macos.rs` already spawns this way.

**Provisioning** (`provision.rs`). On supported targets, LILO downloads pinned
tools that are missing into `<app data>/bin`. Linux mpv is supplied by the
system or an explicit path because the project has no pinned Linux mpv package.
Because downloads are later *executed*, the rules are strict:

* exact versions and SHA-256 digests are **pinned in the source**, never read
  from the server that served the file;
* HTTPS only, and a digest mismatch deletes the file instead of running it;
* downloads land in the app data directory, never on `PATH`, so nothing fetched
  can shadow a system tool;
* a managed binary wins over a system one — behaviour must not depend on the
  user's `PATH` — but an explicit settings override beats both.

Coverage is deliberately honest. `spec_for` returns `None` where no trustworthy
prebuilt exists, and the UI then shows the one command that installs it rather
than pretending:

| Tool | Provisioned | Source |
|---|---|---|
| yt-dlp | macOS, Windows, Linux x86_64/aarch64 | official GitHub release + its `SHA2-256SUMS` |
| yt-dlp | 32-bit ARM: no | no pinned automatic package; the HTTP resolver can be configured instead |
| Deno | Windows x86_64, macOS x86_64/aarch64, Linux x86_64 | pinned release assets and digests |
| mpv | macOS arm64 | stolendata build (self-contained `mpv.app`), digest pinned here |
| mpv | Windows x86_64 | pinned Windows build and digest |
| mpv | Linux and Intel macOS: no | use an available system binary or configured path; the runtime image includes system mpv |

## 7. Tools layer

- Keep tools in Rust (`tools.rs:10-16`); generalize categories: `system`
  (time, apps, files), `web` (search), `iot` (local HTTP).
- The core only ever sees `name` + JSON args; execution goes through
  `run_tool` (`lib.rs:366-391`).
- Security: allowlist, explicit confirmation for system actions, never commit or
  log credentials (`AGENTS.md`).

---

## 8. Decisions taken

1. **Assistant-driven commands.** Enable them only through declared provider
   capabilities. Do not inject executable text markers into spoken output.
   User captions continue to route local commands independently of provider.
2. **Command name source.** Still the last word of the wake phrase.
   `set_assistant_name` rebuilds the registry when the phrase changes.
3. **Command scope.** Built-ins and plugins declare scope in their descriptors.
   Session commands control calls; tool commands include media, time and installed
   application operations.
4. **Locales.** pt-BR, en and it ship together. Locale is metadata only — every
   pattern is always live, because a bilingual user mixes languages mid
   sentence. A regional tag (`it-IT`) resolves to its base locale, never to a
   silent English fallback.

## 9. Headless Linux

`crates/lilo-daemon` runs the shared command router, tools and compatible
plugins without Tauri. It supports standalone ChatGPT voice through an optional
Linux browser/audio host, managed from a phone; a paired desktop is not
required. The browser host supplies the ChatGPT WebRTC session, while the
daemon routes caption updates through the shared desktop router. Controls fire
immediately; song queries wait until the caption settles or becomes final.
Final conversation turns are delivered to compatible plugins once.
Both hosts read tool-result lifecycle flags through `lilo-core`. Successful
playback requests end the voice session before any spoken completion; local
wake remains available to open a new conversation and control the music.
Account availability and quotas remain the provider's rules.

The daemon also registers the shared `MediaService`, so supported hosts can
search and play local audio without Tauri. Media playback uses pinned yt-dlp and
Deno with system mpv and a configured Linux audio endpoint. Remote resolver
availability can vary. The phone search flow displays results and starts the
exact selected YouTube video id rather than resolving only its title.

The daemon uses local PocketSphinx recognition while idle and enabled. Its
finite English command grammar comes from the active command and plugin
registry, so literal commands such as “stop the music” route to daemon tools
without a provider account. The wake phrase starts provider voice only when a
selected account is available. Free-text slots need a dictation-capable engine
and are not provided by the daemon's keyword recognizer. The phone also provides explicit voice controls. See the
[wake architecture](architecture.md#wake-word). The host needs its
Linux browser dependencies plus usable microphone and speaker access. Support
depends on the target CPU architecture and audio setup; Raspberry Pi checks are
recorded separately in [`raspberry-pi.md`](raspberry-pi.md). Standalone daemon
voice currently covers ChatGPT only; third-party plugin transports and other
providers are not implied.

Stories and study plugins can participate through ordinary tool calls and
opening context. QuickJS-owned scheduled jobs also run through the shared core
API when a plugin declares `schedule:self`. Plugin-owned `lilo.interaction` questions
are delivered by daemon voice when the plugin declares `interaction:self`.

The paired desktop satellite remains a separate option. It carries PCM16 audio
between the daemon and a desktop-owned provider session; details and current
board-specific validation belong in [`headless-linux.md`](headless-linux.md)
and [`raspberry-pi.md`](raspberry-pi.md).

### First setup and phone management

The paired phone shell exposes Wi-Fi status, scanning and joining after the daemon
is connected to a network. First-boot access-point provisioning remains separate
and has not been validated with physical Wi-Fi hardware. See [Headless Linux](headless-linux.md) for current device boundaries.
