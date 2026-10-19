# Writing a LILO plugin in JavaScript

This guide is for people building plugins with LILO's embedded QuickJS runtime.
A normal plugin consists of a manifest and one JavaScript file. It runs in the
installed app; you do not edit Rust, React, Tauri commands or the app's CSS.

For the full host contract, see [Plugins](plugins.md). Existing implementations
are in [examples/plugins](../examples/plugins). Start from an example close to
your feature, then change its identity, tools and behavior.

## What you can build

| Feature | Available building blocks | Example |
| --- | --- | --- |
| Voice notebooks, journals, checklists | Voice commands, local JSON/text storage, lists and actions | `notes` |
| Focus timers and reminders while LILO runs | `tick`, persisted timestamps, notifications and countdowns | `pomodoro` |
| Language tutors and learning memory | Tutor briefing, opted-in conversation events, opening context, local review schedules | `study` |
| Music history and replay | `media.playing` events, a list and a `play` result | `history` |
| Generated-picture collections | `image.created`, local image storage, thumbnails and `image.show` | `gallery` |
| Screen-assisted workflows | Screen capture permission, per-platform capture, a `screen` result | `screen` |
| Scoped desktop actions | Discover/open installed apps, insert literal text into a supported field | `desktop` |
| Free-service integrations | Permission-scoped HTTP, local storage, source attribution | `dictionary` |
| Local CLI integrations | Explicitly declared executable, argument arrays, bounded output | See the host API below |
| Additional interface languages | Manifest language packs, English fallback, plugin-owned UI dictionaries | `language-es` |

Timers run only while LILO and the plugin are running. Persist an absolute
deadline if the timer must resume after a restart. A headless plugin can still
store data and respond to commands; desktop operations and visual output need
a desktop host or a connected interface.

## Package layout

Create a marketplace directory with one directory per plugin:

```text
my-marketplace/
  index.json
  notebook/
    plugin.json
    notebook.js
```

The host creates `data/` for your plugin's files and manages `settings.json`.
Do not package either file with user data. Updates preserve them; deactivation
preserves them; uninstall removes the plugin directory and its data.

Use a unique ID and unique tool/command names. Keep `entry` relative to the
plugin directory. Paths cannot escape through `..`, symlinks or absolute names.

## A complete plugin

This notebook demonstrates storage, settings, commands, a dynamic list, a
button and opening context. All feature logic is JavaScript.

**`plugin.json`**

```json
{
  "id": "com.example.notebook",
  "name": "My notebook",
  "description": "Keep and review a small notebook by voice.",
  "version": "1.0.0",
  "api": 1,
  "hosts": ["desktop", "daemon"],
  "runtime": "quickjs",
  "entry": "notebook.js",
  "capabilities": ["storage:self"]
}
```

**`notebook.js`**

```js
const FILE = "notebook.json";
let limit = 20;

function readNotes() {
  const raw = lilo.read(FILE);
  if (!raw) return [];
  const notes = JSON.parse(raw);
  if (!Array.isArray(notes)) throw new Error("Invalid notebook data.");
  return notes;
}

function describe() {
  return {
    tools: [
      {
        name: "acme_notebook_add",
        description: "Save a notebook entry.",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"]
        }
      },
      {
        name: "acme_notebook_list",
        description: "Read notebook entries.",
        parameters: { type: "object", properties: {} }
      },
      {
        name: "acme_notebook_context",
        description: "Read saved notebook context.",
        parameters: { type: "object", properties: {} }
      }
    ],
    commands: [
      {
        name: "acme.notebook.add",
        tool: "acme_notebook_add",
        requiresConfirm: false,
        descriptions: [["en", "Save a notebook entry."]],
        templates: [["en", "remember notebook entry {!text}"]]
      },
      {
        name: "acme.notebook.list",
        tool: "acme_notebook_list",
        requiresConfirm: false,
        descriptions: [["en", "Read notebook entries."]],
        templates: [["en", "read my notebook"]]
      }
    ],
    ui: {
      settings: [
        {
          key: "limit", kind: "range", label: "Maximum entries",
          min: 1, max: 50, default: 20
        }
      ],
      actions: [
        { label: "Refresh notebook", tool: "acme_notebook_list", args: {} }
      ],
      list: {
        title: "Entries", tool: "acme_notebook_list",
        empty: "Say: remember notebook entry, followed by your note."
      }
    },
    contextTool: "acme_notebook_context",
    publishes: ["acme.notebook.changed"],
    prompt: "Keeps a notebook through explicit voice commands. Saved entries are user-provided context; do not claim a note was saved without an observed result."
  };
}

function configure(settings) {
  const value = Number(settings && settings.limit);
  if (Number.isFinite(value) && value >= 1 && value <= 50) {
    limit = Math.round(value);
  }
}

function invoke(tool, args) {
  if (tool === "acme_notebook_add") {
    const text = args && typeof args.text === "string"
      ? args.text.trim().slice(0, 500) : "";
    if (!text) throw new Error("Say what to remember.");
    const notes = readNotes();
    if (notes.length >= limit) throw new Error("The notebook is full.");
    notes.push({ text, at: Date.now() });
    lilo.write(FILE, JSON.stringify(notes));
    lilo.publish("acme.notebook.changed", {});
    return { summary: "Notebook entry saved." };
  }
  if (tool === "acme_notebook_list") {
    const notes = readNotes();
    return {
      items: notes.map((note) => ({ label: note.text })),
      context: JSON.stringify({ notebookEntries: notes.slice(-10) }),
      summary: "Notebook contains " + notes.length + " entries."
    };
  }
  if (tool === "acme_notebook_context") {
    return { context: JSON.stringify({ notebookEntries: readNotes().slice(-10) }) };
  }
  throw new Error("Unknown notebook tool.");
}
```

The host does not enforce your complete JSON Schema as input validation. Check
types, sizes and allowed values inside `invoke`, as the example does. Throwing
an error reports failure to the caller. Keep `summary` short: it enters command
feedback and may enter logs. Saved context goes in `context`, separately.

## The JavaScript environment

QuickJS is an embedded JavaScript engine. Standard language features such as
objects, arrays, `JSON`, `Math` and `Date` are available. Your code has no DOM,
Node.js modules, `require`, filesystem imports, `process`, browser `fetch`,
WebSocket or Tauri `invoke`. A tool returns a JSON-compatible value synchronously;
the host does not await an arbitrary Promise returned by your plugin.

Bundle any pure JavaScript helper you need into the entry file. A library that
depends on Node, browser APIs or remote resources will not acquire those APIs
by being bundled. Use `tick` for timers instead of `setTimeout`/`setInterval`.
Each plugin has its own worker and a 32 MiB heap ceiling. Keep data bounded and
avoid large synchronous jobs. Ordinary tool calls have a 60-second budget;
startup/configuration/event callbacks have a 10-second budget; timer and
graceful-shutdown callbacks have a two-second execution budget. Conversation
delivery and opening-context reads have tighter host budgets described below.

### Lifecycle

| Function | When the host calls it | Your responsibility |
| --- | --- | --- |
| `describe()` | Load | Return tools, commands, UI and subscriptions; describe stable capabilities |
| `configure(settings)` | After load and after settings change | Apply host-owned settings; validate values |
| `invoke(tool, args)` | Voice command, UI action or a host request | Validate and execute one owned tool; return JSON |
| `event(topic, payload, source)` | Subscribed event | Validate data and origin; handle replay where applicable |
| `tick(nowMs)` | About four times per second when the worker is idle | Check deadlines and checkpoint pending state |
| `shutdown()` | Graceful plugin stop, such as update/deactivation | Flush pending state promptly; do not start new work |

Define only the callbacks you need. `describe` and `invoke` are the usual
minimum. `shutdown` is best effort and cannot run after a process crash or
power loss; save during operation too.

## Host APIs and permissions

`lilo` is the only bridge out of the sandbox.

| API | Returns / behavior | Declaration or limitation |
| --- | --- | --- |
| `lilo.read(name)` | UTF-8 text, or `null` when unreadable/missing | Your own `data/` only; declare `storage:self` |
| `lilo.write(name, text)` | Writes UTF-8 text | Your own `data/` only; declare `storage:self` |
| `lilo.memory(operation, options)` | Atomic versioned JSON; revision guard and recovery status | Requires `storage:self`; private records; see durable memory below |
| `lilo.schedule(operation, options)` | Persistent owned-tool jobs and delivery history | Requires `schedule:self`; LILO and plugin must be running |
| `lilo.session()` | Fresh public session snapshot; read-only | Requires `session:read`; no accounts, credentials or vendor conversation ids |
| `lilo.interaction(operation, options)` | Linked questions, explicit confirmations and owned ephemeral history | Requires `interaction:self` and a host that delivers questions into the active voice channel; desktop and standalone ChatGPT daemon voice support delivery |
| `lilo.http(url, options)` | `{status, ok, headers, body}`; UTF-8 text | Exact `http:<domain>` permission; bounded HTTPS; see below |
| `lilo.hostInfo()` | A fresh object with contract/version, installed APIs, permissions, platform and limits | Feature detection; does not grant permissions or expose account data |
| `lilo.publish(topic, payload)` | Publishes JSON-compatible data | Topic must match `publishes` |
| `lilo.platform` | `windows`, `macos` or `linux` | Choose a real implementation for each supported OS |
| `lilo.exec(program, args)` | `{code, stdout, stderr}` | Exact `exec:<program>` capability; argument array; no implicit shell; 15-second budget and 64 KiB output per stream |
| `lilo.temp(name)` | Path to a scratch file | Bare filename; scratch is removed when the plugin unloads |
| `lilo.readBase64(path)` | Scratch bytes as base64 | Confined to scratch; maximum 6 MiB per read |
| `lilo.desktop(operation, args)` | A JSON **string**, parse with `JSON.parse` | `desktop:apps` for `apps`/`open`; also `desktop:text` for `type`; desktop session required |
| `lilo.screenshot(maxEdge)` | Primary-screen JPEG as base64 | `screen:capture`; native implementation currently Windows only; other OSes need the capture paths in the `screen` example |
| `lilo.log(message)` | Diagnostic output | Keep secrets and private conversation content out of messages |

Storage is confined by the runtime; declare `storage:self` for a truthful
manifest. Desktop/screenshot APIs are exposed when their capability is
declared. Executables and HTTP destinations are checked against the manifest.
Use `lilo.http` for declared destinations; there is no browser `fetch`, Node
module or unrestricted network API. Discover available bridge APIs with
`lilo.hostInfo()`.

Prefer scoped desktop APIs over CLI automation. `lilo.desktop("apps", {})`
discovers installed names and opaque IDs. `open` accepts `{app}`; `type` accepts
`{app, text}` and inserts literal text into a supported field. It does not
provide arbitrary keyboard/mouse automation, editor-file access or a shell.

If using `exec`, check exit codes and handle missing programs. Do not assume
an interpreter or OS tool exists. Every supported OS needs a real path through
your JavaScript, or a `platforms` declaration excluding unsupported OSes.
Declare `hosts` separately with `desktop`, `daemon`, or both. Omitted `hosts`
means desktop-only; daemon catalogs and installed lists omit plugins unless
they explicitly include `daemon`.
The host expands a leading `~` in CLI arguments; use scoped storage/scratch
paths for plugin data and avoid relying on platform-specific path syntax.

## Voice commands and tutor behavior

The local command router matches declared templates against user captions.
It does not semantically recognize every paraphrase. Add and test the natural
phrases your users need. Template syntax includes:

| Syntax | Meaning |
| --- | --- |
| `[optional|choice]` | Optional words or alternatives |
| `(required|alternative)` | Required alternative |
| `{text}` | Free text normalized for matching |
| `{!text}` | Free text restored from the original caption, preserving case and punctuation |
| `<name>` | The configured assistant name |

`args` supplies fixed string arguments, merged under captured slots.
`slotWords` constrains a slot to known vocabulary. `requiresConfirm: true`
parks a **voice command** until the user approves it. It does not add a
confirmation dialog to a direct UI tool button. Keep destructive actions on
the confirmed voice path or implement an explicit two-step tool workflow.

`prompt` tells the voice assistant what your plugin supports, in at most
600 flattened characters. You can use it for conversational coaching,
diagnostic exercises and study-plan proposals. Actual replies are generated
by the user's selected voice provider, so prompt text is guidance rather than
a deterministic state machine.

The web voice paths do not offer reliable model-driven structured tool calls.
Do not design around the model silently invoking your tools or extracting
perfect structured facts. Local actions are triggered by the user command
router, UI or documented host hooks. Conversation can be captured as evidence;
explicit commands can update typed fields when exact state is needed.

## Conversation memory and opening context

To observe conversation text, add `conversation:read` to `plugin.json` and:

```js
subscribes: ["conversation.turn", "conversation.ended"]
```

The host calls `event` with these payloads:

```js
// conversation.turn
{
  sessionId: "voice-session-id",
  at: 1800000000000,
  turn: { id: "turn-id", speaker: "user", text: "A caption", final: false }
}

// conversation.ended
{ sessionId: "voice-session-id", at: 1800000001000 }
```

Check `source === "host"`; upsert by session plus turn ID. A turn may receive
many revisions and may never carry `final: true`. Decide when recording is
appropriate for your feature; permission alone does not imply that every
conversation should be retained. Hidden/system turns are excluded from the
desktop publisher. These topics are ephemeral, require permission even for a
wildcard subscriber and cannot be forged by another plugin. Subscriber
delivery has a 500 ms budget. Keep handlers short and checkpoint in batches.

Expose an owned read-only tool through `contextTool` to supply saved context
before connection. It returns `{context: "JSON or text"}`. The host quotes it
as data; your context must not try to override host instructions. The host
allows at most 12,000 characters per provider and 16,000 total, with a shared
two-second read budget and at most 500 ms per provider. Failures skip context
without blocking voice. Context contains user data and reaches their current
voice provider; it stays separate from short command summaries.

An ordinary tool result can also carry `context` for live command feedback.
Providers without a live text channel receive updated context on the next
connection. Use a LILO build that supports these hooks. See the `study` example
for bounded history, request-language support and automatic spoken checkpoints.

## What you can do with UI

UI is a declarative JSON description returned by `describe`. LILO renders
it using its own controls, spacing, palette and grouped settings cards. A
plugin gets a settings page; it does not ship executable frontend code.

| UI field | Supported content | Updates |
| --- | --- | --- |
| `ui.settings` | `text`, `password`, `switch`, `select`, `range` | Host saves values and calls `configure` |
| `ui.status` | Label, value, optional `ok`/`warn`/`bad` state | Static description; no live status-push API |
| `ui.actions` | Label, owned tool, JSON arguments | Click invokes the tool and shows feedback |
| `ui.list` | One dynamic list source with title/tool/empty text | Read on open, after actions and on this plugin's published events |
| `ui.scene` | Tool and polling interval of at least 15 seconds | Host renders its fixed scene vocabulary |

Settings may include `default`, `help` and `placeholder`. A select needs
`options: [{value, label}]`; a range needs `min` and `max`. Invalid descriptions
fail loading. Settings values are owned by the host; do not overwrite
`settings.json` yourself. Password fields hide text in UI but settings are
currently stored in plain text, not an OS keychain.

A list tool returns:

```json
{
  "items": [
    {
      "label": "An entry",
      "detail": "Optional secondary text",
      "action": {
        "label": "Open", "tool": "your_owned_tool", "args": {"id": "entry-1"}
      },
      "image": {"file": "pictures/entry.b64", "mime": "image/png"}
    }
  ],
  "summary": "Entries loaded."
}
```

`detail`, `action` and `image` are optional. Images are base64 text files
written into your own data directory; supported MIME types are PNG, JPEG,
WebP and GIF. The host draws thumbnails and opens the full image. Publish a
declared change topic when the list changes so an open page refreshes.

Current UI cannot contain HTML, React components, custom JavaScript, CSS,
remote fonts, arbitrary layouts or canvas widgets. Dynamic data belongs
in the list; a new reusable control needs a host-contract extension. All
essential actions should also have a voice path for headless users.

### Card dashboards and editable lists

A `ui.cards` tool may return `dashboard` beside its `title` and `detail`:

```json
{"dashboard":{
  "hero":{"label":"Task coverage","value":30,"detail":"Provisional evidence"},
  "metrics":[{"label":"Practice days","value":"4","detail":"This week"}],
  "skills":[{"label":"Pronunciation","value":null,"detail":"Not assessed yet"}],
  "series":[{"label":"Daily practice","kind":"bars","max":10,"points":[
    {"label":"2026-10-07","value":3,"detail":"Recorded attempts"}
  ]}],
  "highlights":[{"label":"Next step","detail":"Try a short recall exercise"}]
}}
```

These are host-rendered SVG charts, not plugin markup. Hero and skill values
are 0–100; a null skill is unknown. Metrics use string values. Series kinds
are `bars` and `line`; maxima are finite and positive, with points inside
their range. Rendering is bounded to eight metrics, eight skills, three
series, sixty points per series and six highlights. Values are also available
in accessible tables. Malformed fields are dropped; text is escaped and
uses the plugin's localization dictionary. Cards refresh on plugin events.

A list row can expose `edit` with `tool`, `label`, `matchParameter`,
`valueParameter`, optional editable `value` and bounded `args`, plus `deleteAction` with
`tool`, `label` and `args`. Tools must belong to the plugin. Fixed edit
arguments carry stable IDs; the host adds the old editable value and replacement under
the declared keys. Check the old text before replacing a changed row.
Delete controls ask for confirmation; nonempty details receive a copy button.
Voice notes demonstrate creation, live read, editing and deletion, preserving
legacy plaintext notes while migrating to native local memory. The creation
form accepts 600 characters; voice tools accept 2000. Edits and deletions
purge previous native recovery versions and clear the migrated plaintext.

### Tool results that affect the app

These fields request effects the host already knows how to render or route:

| Result | Effect |
| --- | --- |
| `{mood: {kind: "happy"}}` | A temporary mascot expression; also `sad`, `angry`, `surprised`, `neutral` |
| `{scene: {kind: "rain", intensity: 0.5, night: false}}` | Background scene; fixed kinds include `none`, `clear`, `sun`, `clouds`, `fog`, `rain`, `snow`, `storm`, `heat`, `cold` |
| `{screen: {data: "base64", mime: "image/jpeg", text: "Context"}}` | Submit an image to a capable live voice provider |
| `{play: {track: "Track", artist: "Artist"}}` | Resolve and play music through LILO's player |
| `{imagine: {prompt: "Description"}}` | Ask a capable voice provider for a generated picture |
| `{endSession: true}` | End the live voice session after the tool completes |

Visual and provider effects depend on the host's declared capabilities. They
do not grant access to account credentials or let a plugin replace the player,
renderer or provider. UI buttons invoke tools and show summaries; they are not
automatically a voice conversation or a tutor request.

## Events, notifications and countdowns

Plugins communicate through topics, not direct calls to another plugin.
Declare `subscribes` and `publishes` in `describe`. Patterns support an exact
topic, a prefix such as `acme.notebook.*`, or `*`. General topics retain their
latest event for newly loaded subscribers; conversation topics do not.
Make event handlers idempotent and validate payloads. A plugin does not
receive its own events.

Useful existing topics:

| Topic | Purpose |
| --- | --- |
| `location.changed` | Location coordinates, name, timezone and source |
| `media.playing` | Track ID/title/artist/URL/duration |
| `image.created` | Generated image ID, provider, prompt, MIME and base64 bytes |
| `notify` | Toast/chime and optional spoken notification during a capable live call |
| `statusbar` | Countdown label, deadline and owned action menu |
| `image.show` | Display plugin-owned images |

For a reminder, declare `publishes: ["notify"]` and call:

```js
lilo.publish("notify", { summary: "Time to review your notes.", chime: true });
```

For a countdown, declare `statusbar` and publish:

```js
lilo.publish("statusbar", { label: "Review", endsAt: Math.floor(Date.now() / 1000) + 600 });
```

The host counts down; your plugin need not publish every second. `endsAt` is
Unix **seconds**, while conversation timestamps and `tick(nowMs)` use
milliseconds. Publishing `{}` removes your countdown. Notifications do not
start a voice session by themselves. See [Plugins](plugins.md) for complete
payloads and the `pomodoro`/`gallery` examples for working event workflows.

## Build, install and test without editing the host

1. Put your manifest and entry file in a marketplace directory.
2. Generate `index.json` with the repository's cross-platform builder:

   ```sh
   node scripts/build-marketplace.mjs /absolute/path/to/my-marketplace
   ```

   Run from the LILO checkout, or use the absolute path to that script. On
   Windows, use a Windows path for your directory; Node runs the same builder.
   It computes SHA-256 digests from every packaged file. Do not list `data/`,
   `settings.json` or `.disabled` as package files.

3. In the app, set Settings → Plugins → Marketplace URL to your directory's
   absolute path, refresh the catalog and install your plugin.
4. Exercise commands **in the app**, open the plugin page, change settings,
   restart, deactivate/reactivate and test failure paths. Browser-only testing
   cannot exercise the embedded runtime or native host APIs.
5. After changing packaged files, bump your plugin version, rebuild the index
   and update the installed plugin. An installed copy is separate from your
   source directory; updates require a newer dotted version.

Node is a development/catalog tool, not a runtime requirement for an installed
QuickJS plugin. You can unit-test pure JavaScript with `node:test` and a small
fake `lilo` object; the repository's `study-plugin.test.mjs` demonstrates this.
An app test is still needed because Node is not QuickJS and fake APIs cannot
establish native permissions or provider behavior. No Rust edits or app rebuild
are needed when your plugin uses APIs already available in the installed host.

Use a public HTTPS marketplace for distribution; localhost HTTP is allowed
for development. Digests establish file integrity against the catalog, not
publisher identity. Keep credentials, personal addresses and user data out of
the package, catalog and repository history.

## HTTP and host discovery

Use the existing native HTTP client through a permission-scoped bridge. Your
feature stays entirely in JavaScript; the host does not know about a dictionary,
news reader or any other service-specific workflow.

```js
function lookup(word) {
  if (typeof lilo.hostInfo !== "function" || typeof lilo.http !== "function") {
    throw new Error("This feature needs a LILO host exposing plugin HTTP.");
  }
  const host = lilo.hostInfo();
  if (!host.apis.includes("http")) throw new Error("HTTP is unavailable.");
  const response = lilo.http(
    "https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word),
    { method: "GET", timeoutMs: 5000, maxResponseBytes: 131072,
      headers: { Accept: "application/json" } }
  );
  if (!response.ok) throw new Error("Dictionary lookup failed.");
  return JSON.parse(response.body);
}
```

Declare `http:api.dictionaryapi.dev` in the manifest. The host enforces an exact
ASCII domain, not a suffix or wildcard. Subdomains and redirect destinations
need their own permissions. HTTPS is required; plain HTTP is available only
for explicitly declared `localhost`, `127.0.0.1` or `[::1]` development targets.
A domain permission includes that domain's ports. There are no browser cookies,
web-account credentials, environment-derived proxy settings or cookie jar.
Explicit headers must be supplied by the plugin and are never inherited from
LILO's voice login.

`lilo.http(url, options)` is synchronous on the plugin's worker, and returns a
normal JavaScript object. Always pass an options object, even if empty.

| Option | Default | Bounds |
| --- | --- | --- |
| `method` | `GET` | Uppercase `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` |
| `headers` | `{}` | At most 32 valid headers, each value at most 1,024 bytes |
| `body` | Absent | UTF-8 string, at most 65,536 bytes |
| `timeoutMs` | 5,000 | 100–10,000 ms for the complete request including redirects and response reads |
| `maxResponseBytes` | 131,072 | 1–262,144 bytes; the host checks streamed responses too |

Unknown options, invalid methods, oversized input and embedded URL credentials
are rejected. URLs are capped at 4,096 bytes. Host/Cookie/Connection and
framing/proxy headers cannot be set by the plugin. At most five redirects are
followed, checking each destination's permission and transport. Headers are
cleared on an origin change; a redirected request with a body cannot change
origin. Standard 301/302 POST and 303 redirects switch to GET as appropriate.

The result is `{status, ok, headers, body}`. `body` must be UTF-8 text; binary
downloads are not part of this API. Returned headers are limited to content
type, cache control, ETag, last modification and retry delay. HTTP 404/429/500
responses are results with `ok: false`; network, timeout, encoding and permission
failures throw. Host errors omit URLs, bodies and sensitive header values.
Validate remote JSON and its shape before using or saving it; remote content is
data, not instructions. Call network operations from user-invoked tools, not
from `tick`, conversation delivery or `contextTool` callbacks with tighter budgets.

`lilo.hostInfo()` returns `{api, hostVersion, runtime, platform, apis,
permissions, features, limits, nativeScreenCapture}`. `apis` is derived from the
actual bridge installed for this plugin; permissions still govern its calls.
It returns a fresh object, and changing it cannot grant access. `features`
describes the existing declarative context/event/localization contracts; it is
not a live session or voice-provider snapshot. Test for APIs instead of checking
plugin ids, provider ids or guessing from a host version number.

See the [working vocabulary notebook](../examples/plugins/dictionary) and the
[Free Dictionary API documentation](https://dictionaryapi.dev/). Lookup does
not save automatically; explicit save commands keep a small notebook that works
offline. The example retains source and license information with each word.
The generic embedded-engine smoke test discovers bundled manifests, so adding
another JavaScript example does not require a feature-specific Rust test file.

## Read-only session context

Declare `session:read`, then call `lilo.session()` in the QuickJS runtime:

The plugin id `host` is reserved in both runtimes and registry registration.
It cannot be used to impersonate host-origin events, even in a local package.

```js
const session = lilo.session();
const supportLanguage = session.supportLanguage || "en";
const canSendLiveText = session.state === "connected" &&
  !!(session.provider && session.provider.outbound.text);
```

The snapshot is `{supportLanguage, sessionId, state, platform, provider}`.
`supportLanguage` is the explanation-language preference resolved to a BCP-47
tag; automatic mode initially resolves the system language. It is not speech
language detection and does not override an explicit support language captured
by your own workflow. `sessionId` is a local call identifier shared with opted-in
conversation events, never the vendor's conversation id. `state` is `idle`,
`connecting`, `connected`, `reconnecting`, `disconnected` or `error`.

`provider` is null or the public protocol capabilities:
`inbound: {userText, assistantText, nativeToolCalls, images}` and
`outbound: {text, stopSpeaking, systemPrompt, toolResult, image}`. These are
declared abilities, not proof of successful delivery. Account identifiers,
credentials, provider options, transcript history and connection error details
are deliberately absent. `platform` comes from the native host.

Subscribe using `subscribes: ["session.changed"]` and implement
`event(topic, snapshot, source)`. Updates are host-owned, permission-scoped and
retained for late authorized subscribers. Forged plugin events and invalid
metadata cannot overwrite the public snapshot. Read again when handling an
update; returned objects do not mutate host state. The voice owner publishes
language/connection changes serially so old updates cannot arrive after newer
ones. A slow listener has a 500 ms delivery wait budget.

Before metadata is supplied, language/session/provider can be null and state
is idle. The daemon reports a null provider while no voice session is active;
during standalone ChatGPT voice it reports that session's declared
capabilities. Do not infer a voice channel from the existence of transcription
events. The process runtime can subscribe to authorized session events but
does not expose the native `lilo.session()` function.

The complete [offline travel phrasebook](../examples/plugins/phrasebook/)
uses the current language for explanations and declared outbound text support
for its delivery guidance. It works without feature-specific Rust/React code.

## Durable memory and scheduled work

Memory belongs to the local user/plugin, independently of the voice provider.
Keep course identity and progress in plugin records; never key them by provider
id, account or vendor conversation id. Switching adapters must read the same
record and continue the same course. Provider capabilities govern delivery,
not memory ownership. `contextTool` exposes fresh bounded continuation data to
every compatible adapter at connection time. Ephemeral `sessionId` identifies
the current call and must not become a permanent course partition.

These APIs are currently available in the QuickJS runtime. A process plugin
can manage its own files and timers; its stdio protocol does not expose these
native calls. Detect the APIs with `lilo.hostInfo().apis`, declare the required
permissions, and report missing capability instead of silently degrading.

### Atomic memory

```js
const record = lilo.memory("read", {key: "learning"});
if (record.found && record.schemaVersion !== 1) {
  throw new Error("Unsupported schema; existing memory was preserved.");
}
const saved = lilo.memory("write", {
  key: "learning", schemaVersion: 1, expectedRevision: record.revision,
  value: {nextLesson: "Ordering lunch", lastPractice: Date.now()}
});
// Re-read on a revision conflict; do not blindly overwrite newer evidence.
lilo.memory("delete", {key: "learning", expectedRevision: saved.revision});
```

Every response is `{found, value, schemaVersion, revision, recovered}`. An absent
record has revision 0. Writes require `value` (including explicit `null`) and
a positive `schemaVersion`; `expectedRevision` is optional. This is an
optimistic guard within the plugin's single worker, not a database transaction
across concurrent processes. There is no multi-record transaction.

Keys are 1–64 ASCII letters/digits/underscores/hyphens, normalized to lowercase
so identity is consistent on case-sensitive and case-insensitive filesystems.
There are at most 32
records and each encoded envelope is at most 4 MiB. Storage is confined to
`data/.lilo-state/memory/`; legacy `read`/`write` cannot access that reserved
namespace. Reserved paths reject symbolic links. Ordinary raw text files
continue to work as before; they do not become atomic automatically.

Writes flush a sibling staging file and replace the current snapshot with an
atomic rename. A previous valid snapshot is kept for recovery. Unix also syncs
the directory. Filesystem/OS durability still governs power-loss behavior;
this is not a guarantee against hardware failure. Reads recover a valid backup
after a corrupt or missing current snapshot and set `recovered: true`.
Unsupported host formats are preserved and rejected. Plugins own their schema
validation/migrations and should refuse unknown future schemas.

Use `purgePrevious: true` when forgetting or replacing private evidence: the
backup is sanitized before the current snapshot is committed. `delete` removes
both copies using sanitized tombstones during cleanup. Recovery must not bring
forgotten content back after a successful operation. Staging files interrupted
by a process crash can remain in the reserved directory; never treat them as
records or backups.

The `dictionary` and `study` examples import their actual legacy JSON files
after validation, commit the native record, then sanitize obsolete files. An
older host retains the previous storage path. After migration, downgrading the
host does not make the new record available through the old raw-file API.

### Persistent scheduling

```js
lilo.schedule("put", {
  id: "daily-review", tool: "review_due", args: {batch: 3},
  at: Date.now() + 60_000, everyMs: 86_400_000, missed: "runOnce"
});
const state = lilo.schedule("list", {}); // {jobs, history, recovered}
lilo.schedule("cancel", {id: "daily-review"});
```

`put` replaces a job with the same id, or adds one up to a 32-job quota. The
tool must be declared by this plugin. `at` is a positive epoch millisecond
integer within JavaScript's safe integer range. `args` defaults to `{}` and
must be an object within 8 KiB. Job ids follow the memory-key character/length
rules. Optional `everyMs` is a fixed interval from one minute to 365 days;
omit it for a one-shot job. Fixed intervals are not local calendar dates.

`missed` defaults to `runOnce`: deliver a past-due job once and advance a
recurring job directly to its next future occurrence. `skip` discards deliveries
more than 60 seconds late. No policy replays a catch-up burst. Queue/history
live separately from plugin memory and never contain another plugin's jobs.

The worker invokes `invoke(tool, args)` with an added `_schedule` object:
`{id, scheduledAt, deliveredAt}`. Return values are not routed into a voice
conversation; publish `notify` or your own event explicitly. Callbacks use the
two-second JavaScript tick budget, with up to four due jobs per worker pass.
Keep them short and avoid blocking network calls; the JS interrupt cannot
interrupt a synchronous native HTTP call while it is blocked.

A durable claim is stored before invoking the tool. History keeps the latest
32 attempts with `claimed`, `completed`, `failed` or `skipped` status. Completed
means the callback returned, not that the user saw/heard its output. A crash
after claiming can lose that occurrence and leave `claimed`; it is not retried.
This provides at-most-once attempts, not guaranteed delivery. Jobs survive
restart and disabling; deleting the plugin deletes its data. A job whose tool
was removed in an upgrade is recorded as failed.

For local daily times and DST, compute the next one-shot timestamp in JS and
re-arm inside the callback. See the complete
[daily vocabulary review](../examples/plugins/vocabulary-review/) example.
It persists user-authored cues and explicit recall reports, resumes due words
offline, and keeps calendar/learning rules entirely in JavaScript. Notifications
require running LILO; they do not launch an OS service or a new voice call.

## Adding a language without changing the host

A translation plugin is an ordinary QuickJS package. Add `languages` to
`plugin.json`; no Rust or TypeScript edits are needed for another language.
Each pack supplies a BCP-47 tag, its native display name and a dictionary of
the host's existing English message keys:

```json
{
  "languages": [{
    "tag": "es-ES",
    "name": "Español",
    "messages": {
      "language.title": "Idioma",
      "language.label": "Idioma de la conversación"
    }
  }]
}
```

This is a fragment to add to the complete manifest above. A translation-only
entry can simply define `function describe() { return { tools: [] }; }`.
See [the working Spanish starter](../examples/plugins/language-es). It is
intentionally partial, not a complete Spanish localization.

After installing and enabling the plugin, open Settings → Language and select
its language. It translates the app's interface and sets the conversation
language preference. Model language support still depends on the active web
voice provider. The same JavaScript and JSON work on Windows, macOS and Linux;
a headless host loads the package without requiring a screen.

Export the current English dictionary from a checkout:

```sh
node scripts/export-translations.mjs .tmp/plugin-translations.en.json
```

Translate the values and paste the dictionary into the pack's `messages`.
Keep keys and placeholders such as `{language}`, `{name}` and `{count}`.
Unknown keys or entries with mismatched placeholders are ignored. Missing
entries fall back to English, so partial packs remain usable after an app
update adds phrases. The exporter uses Node and TypeScript during authoring;
the installed plugin needs neither.

Tags are canonicalized. An exact region match wins, then another installed
pack for the same primary language. Disabling, uninstalling or failing to
load a plugin removes its contributions from the interface. The saved language
preference remains; the interface falls back to English until a matching pack
is available again. Packs cannot replace the built-in English, Portuguese or
Italian dictionaries. If active plugins claim the same tag, the first plugin
id in sorted order wins; dictionaries are not silently mixed.

The host accepts at most sixteen packs per plugin, 4,096 dictionary entries
per pack, 8,000 characters per translated phrase and 256,000 characters of
translated values per pack. Display names are limited to 120 characters.
This is text localization, not an HTML or executable extension.

### Translating your plugin's own UI

Use `localized` in the manifest for translated names and descriptions. Use
`ui.localized` in `describe()` for settings, status rows, buttons, list titles,
empty text and fixed text in dynamic list rows:

```js
function describe() {
  return {
    tools: [{ name: "example_list", description: "Read entries.",
      parameters: { type: "object", properties: {} } }],
    ui: {
      localized: { es: {
        "Entries": "Entradas", "Refresh": "Actualizar", "No entries yet.": "Todavía no hay entradas."
      } },
      actions: [{ label: "Refresh", tool: "example_list" }],
      list: { title: "Entries", tool: "example_list", empty: "No entries yet." }
    }
  };
}
```

This fragment assumes an `invoke` implementation for `example_list`.
Dictionary keys are the original display strings. Region-specific dictionaries
take precedence over primary-language dictionaries. Untranslated text stays
as supplied by the plugin. Only display fields are translated: setting keys,
select values, defaults, tool names, arguments and image paths remain intact.
User-entered content should remain the user's text.

Translations for a plugin's voice commands belong in its `descriptions` and
`templates` arrays, using the locale as shown above in the voice-command
section. Those arrays already accept additional languages; they do not need
Rust changes. A UI dictionary does not translate command templates or create
new command actions. Web-provider-owned pages are outside the app's
translation dictionary.

## When a feature needs a new host capability

A JavaScript plugin can only use the bridge and UI vocabulary the host
exposes. New native device access, a new visual component or a
new voice-provider transport needs an extension to that contract.

That work belongs to LILO maintainers: define a reusable API, permissions,
inputs/results, platform/headless behavior and tests, then document it here.
Implement the feature's own workflow and data rules in JavaScript. A plugin
author should not need a private Tauri command, a Rust patch or edits to a
shared React component for every feature.

The study feature introduced generic conversation-event and opening-context
hooks because those hooks were missing. They are now available to other
JavaScript plugins. A missing hook should become a documented reusable host
capability, rather than a special branch for one plugin ID.

LILO also has a `process` escape hatch for integrations needing another runtime
or a long-lived process. It has different sandbox/platform requirements; see
[Plugins](plugins.md). QuickJS is the standard path covered by this guide.

## Linked questions and confirmed answers

Use `interaction:self` for a bounded interview. Declare
`subscribes: ["interaction.changed"]` and check both `source === "host"`
and the returned question id in `event`. Add `session:read` if your plugin
uses `lilo.session()` to choose the question language. The host owns matching,
correlation and confirmation; the plugin owns its workflow and durable data.

```js
const pending = lilo.interaction("ask", {
  question: "How many minutes can you study each day?",
  answer: {kind: "number", min: 5, max: 60, suffixes: ["minutes"]},
  confirmation: {
    question: "You said {answer} minutes per day. Is that correct?",
    accept: ["yes", "correct"], reject: ["no", "incorrect"]
  },
  cancel: ["cancel"], timeoutMs: 30000, retries: 1
});
```

`ask` returns a record with `id`, `pluginId`, `sessionId`, `status` and
`phase`. Only one voice question can be pending across all plugins; another
request fails instead of mixing answers. `list` returns your own `active`
record and `history`; `cancel` takes `{id}` and can cancel only your question.
History contains at most 32 records globally and is ephemeral, not course
storage. Restarting or changing voice sessions does not resume an interview.

Answer shapes:

- `number`: finite `min`/`max` within ±1 billion; optional recognized
  `prefixes` and `suffixes`. Plain numeric captions also work. Decimal comma
  is accepted; number words are not inferred by an LLM.
- `choice`: 1–20 `choices`, each with `label`, scalar `value` and explicit
  `matches` aliases. Aliases cannot overlap.
- `text`: required `prefix` and `maxLength` of 1–600 UTF-8 bytes. The prefix
  must be followed by a space; the returned text is normalized to lowercase.

Matching trims whitespace and trailing sentence punctuation and ignores case.
Supply localized aliases yourself. Confirmation requires exactly one
`{answer}` placeholder and nonempty `accept`/`reject` arrays. Confirmation
and cancellation aliases must be distinct. Each alias array has at most
16 entries, each at most 120 UTF-8 bytes. Questions are at most 1000 bytes,
options at most 32 KiB. Timeout is 5–120 seconds per attempt, retries 0–2.

The host publishes `interaction.requested` to the voice owner with attempt
identity and deadline. The owner submits the question through the current
adapter and reports `interaction.delivery`. `submitted` means a local
adapter call succeeded; it does **not** prove audible playback or receipt.
Plugin attempts to forge interaction events are rejected. Only the owning
plugin receives its `interaction.changed` records; raw answers are not retained
on the general event bus.

A successfully submitted question becomes `awaitingAnswer`. A fresh final
user turn with a matching answer produces a candidate and another delivery
attempt for the confirmation question. After that attempt is submitted,
status is `awaitingConfirmation`. Only a distinct fresh user turn accepting
the confirmation produces `confirmed` with `answer`. Assistant turns,
partials, old caption revisions and unrelated answers cannot confirm it.
A native command confirmation interrupts the interview so its approval
cannot also approve the study budget.

Other terminal states are `declined`, `canceled`, `timedOut`, `unsupported`
and `failed`. Session end, loss of a suitable channel or plugin shutdown
cancels pending work. Timeouts have bounded retries. The daemon supports
standalone ChatGPT voice, but does not yet deliver plugin-owned interaction
questions through that session. The interaction API returns `unsupported`
there; the plugin can still read the same saved routine.

Write durable memory **only** after an owned `confirmed` event. Consume the
terminal id once, guard memory revisions and report saving only after a
successful atomic write. A candidate, submission or provider suggestion is
not permission to update the course. A disk failure preserves the old routine.
Never partition durable courses by this temporary `sessionId`.

Real examples: `study` updates the selected language course's daily routine;
`study-routine` is a small standalone interview demonstrating the same contract.
Their READMEs describe app checks and transcription limitations.

### Multiple live lists

`ui.lists` is an optional array of independent `ListSource` sections:

```js
ui: {lists: [
  {title: "Today's review", tool: "study_due", empty: "Nothing due today."},
  {title: "Recent practice", tool: "study_practice", empty: "No practice yet."}
]}
```

Each tool returns `{items: [{label, detail, action?, image?}]}` using the
existing list contract. The original `ui.list` remains supported. Both fields
together may declare at most eight lists. Titles are nonempty and at most
160 UTF-8 bytes, tool names at most 128 bytes, empty messages at most 400 bytes.
Static actions, scene sources and all list sources must name tools declared
by the same plugin; both QuickJS and process hosts reject unowned references.

The UI examines at most the first 64 items of each result. It drops rows with
labels longer than 400 JavaScript characters or details longer than 8000.
Lists refresh on plugin events and after page actions, use grouped cards and
translate titles/empty messages through `ui.localized`. Tool names and data
are never translated. They are optional presentation: expose voice commands
for the same read tools so headless learners can use them too.

The existing `study` example separates today's due expressions and recent
practice while preserving its original learning-memory list. These are
read-only views of the same local course, not additional storage copies.

### Editable and removable text rows

A list row may include `edit: {label, tool, matchParameter, valueParameter, value?}`
and `deleteAction: {label, tool, args}`. These dynamic action tools must also
be among the tools owned by the plugin; the host drops foreign references.
Arguments are limited to 8 KiB. The host renders a multiline editor
and asks the user to confirm deletion before invoking the plugin tool. The
edit tool receives `edit.value` (up to 8,000 characters), or the row detail
when omitted, under `matchParameter` and edited text under `valueParameter`.
Use `edit.value` when the visible detail contains metadata rather than the
editable text. The delete action receives its declared `args`. Keep
both tools in your plugin, validate exact old values and persist atomically.
A row with `detail` also gets a host-owned Copy control; it uses the system
clipboard and a temporary-field fallback for restricted WebViews. These
controls use LILO's standard grouped UI and localized labels.

## Cards, progress and forms

Use a card or progress descriptor as a bounded read-only tool view:

```js
ui: {
  cards: [{title: "Weekly goal", tool: "study_weekly_goal"}],
  progress: [{title: "Review progress", tool: "study_review_progress", max: 5}]
}
```

A card tool may return `{title?, detail?}` (160 and 1200 characters max). A
progress tool returns a finite numeric `value` and optional `label` (400
characters max); the host clamps the bar to `0..max`. Descriptors require a
owned tool, bounded title and positive finite maximum no greater than one
billion. At most eight cards and eight progress indicators are allowed.

Forms use declared fields and submit to one of the plugin's own tools:

```js
ui: {forms: [{title: "Daily routine", tool: "save_routine", submitLabel: "Save", fields: [
  {key: "minutes", label: "Minutes per day", kind: "number", required: true, min: 5, max: 120}
]}]}
```

Forms support `text`, `number`, `select` and `switch`. Each form has 1–12
fields; keys are unique and at most 64 characters, labels at most 120, select
options 1–20, and text maxLength 1–600. Number fields require finite ordered
min/max values. The host validates values again on submit, bounds strings,
checks select values against declared options, and displays errors without
calling the tool. A page supports at most eight forms. The plugin must still
validate every tool argument and persist changes safely.

Set `requiresConfirm: true` on a destructive static action. The host asks
explicit confirmation before dispatching it. Dynamic delete row actions also
require confirmation automatically. Voice commands continue to use their
existing `requiresConfirm` declaration and the shared command router
confirmation path. A checkbox in a form is not a confirmation.

The study dashboard is a working example: a weekly goal card, self-reported
review progress, due-review and recent-practice lists, and a daily routine
form. The progress display counts learner reports; it must not imply a
verified language level.
