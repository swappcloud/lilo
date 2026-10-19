# Plugins

Everything LILO can *do* goes through one registry. Built-ins and third-party
plugins share the public contract. New workflows use existing APIs; a missing
native primitive needs a reusable host extension first.

Start with the English [JavaScript author guide](plugin-authoring.md) for
working code, available APIs, UI controls, language packs and distribution.

## Anatomy

A plugin is a folder. No SDK to link, no Rust ABI to match, and — for the
default runtime — no interpreter to install:

```
plugins/hello/
  plugin.json     identity: id, name, version, api, capabilities, runtime, entry
  hello.js        `runtime: "quickjs"`: one file, every OS
```

`plugin.json`:

```json
{
  "id": "com.lilo.hello",
  "name": "Hello",
  "version": "1.0.0",
  "api": 1,
  "hosts": ["desktop", "daemon"],
  "capabilities": ["storage:self"],
  "runtime": "quickjs",
  "entry": "hello.js"
}
```

* `id` — stable, reverse-DNS-ish, letters, digits, `.`, `-` and `_` only (it
  names the plugin's folder). Two plugins cannot share one.
* `api` — the host contract this was written against. A mismatch is refused at
  load, not at the first call.
* `hosts` — optional runtime targets: `desktop` and/or `daemon`. If omitted,
  the plugin is desktop-only. The headless daemon loads and lists only plugins
  that explicitly include `daemon`; operating-system support is a separate
  `platforms` declaration.
* `runtime` — `"quickjs"` (the default for new plugins) or `"process"`.
  * **quickjs** — the host runs the file in its embedded JavaScript engine.
    One `.js` file works on Windows, macOS, Linux and a headless Linux device, with no
    interpreter to install and no per-platform scripts. See
    [Embedded JavaScript](#embedded-javascript-quickjs) for the API.
  * **process** — `entry` is a program the host starts and talks to over
    stdio ([Protocol](#protocol)). Any language, best for a tool that a
    sandboxed script cannot be — a long-lived child, another runtime — and the
    price is one file per platform (`entries`) or `platforms`.
* `entry` — **relative** path. `../` or an absolute path is an escape attempt
  and the plugin is refused.
* `entries` (process only) — optional per-platform override of `entry`: keys
  `windows`, `macos`, `linux`, or `unix` (macOS and Linux). Windows cannot
  start a script directly, so a process plugin ships one file per platform:

  ```json
  "entry": "notes.sh",
  "entries": { "windows": "notes.ps1" }
  ```

  The host runs the entry itself on macOS and Linux; on Windows a `.ps1` goes
  through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File` and a
  `.cmd`/`.bat` through `cmd.exe /C`. A native executable entry is started
  as-is on every platform.
 * `platforms` — optional list of the operating systems the plugin exists on
   (`windows`, `macos`, `linux`, or `unix` for both Unix ones). Omitted means
   every platform. A plugin that genuinely cannot exist on an OS declares it,
   is skipped there without being reported as a failure, and the marketplace
   does not offer it on the other platforms.
* `capabilities` — declared permissions (`http:<host>`, `exec:<bin>`,
  `storage:self`, `audio:out`, `desktop:apps`, `desktop:text`). Declared, shown in Settings, and the seed of the
  marketplace consent screen. The quickjs runtime enforces what it can (see
  below); a process plugin can do anything its user account can.

## Embedded JavaScript (quickjs)

The default runtime. A plugin is one `.js` file that defines four functions —
the same declarations the process protocol carries, minus the plumbing:

```js
function describe() {
  return {
    tools: [{ name: "notes_add", description: "Save a short note.",
              parameters: { type: "object", properties: { text: { type: "string" } } } }],
    commands: [{ name: "notes.add", tool: "notes_add",
                 templates: [["en", "note that {text}"], ["pt", "anota que {text}"]] }],
    ui: { settings: [{ key: "max", kind: "range", label: "Max notes", min: 1, max: 50 }] },
    publishes: ["notify"],
    prompt: "Keeps a voice notebook."
  };
}

function invoke(tool, args) { ... }     // returns the result object
function configure(settings) { ... }    // settings pushed by the host
function event(topic, payload, source) { ... }   // only declared subscribes
function tick(nowMs) { ... }            // called ~4×/s: timers live here
```

Every function is optional; `describe`/`invoke` are what a tool needs. The
declarations use exactly the shapes in
[What a plugin can declare](#what-a-plugin-can-declare).

The host API is deliberately small — everything else is sealed:

| Call | What it does |
| --- | --- |
| `lilo.read(name)` / `lilo.write(name, text)` | the plugin's own `data/` folder; `..` and absolute paths are refused |
| `lilo.http(url, options)` | Structured `{status, ok, headers, body}` from bounded HTTPS to an exact declared `http:<domain>`; no browser accounts, cookies or implicit redirects. See the author guide. |
| `lilo.hostInfo()` | Structured public-contract version, actual installed APIs, permissions and platform/budgets; feature detection, not permission escalation. |
| `lilo.memory(operation, options)` | `storage:self`; atomic JSON records with schema/revision, bounded recovery and forgetting |
| `lilo.schedule(operation, options)` | `schedule:self`; persistent owned-tool jobs, cancellation and bounded delivery history |
| `lilo.session()` | `session:read`; read-only public session language/id/state, platform and declared provider protocol capabilities |
| `lilo.interaction(operation, options)` | `interaction:self`; bounded linked voice questions, separate user confirmation, owned ephemeral history; see the author guide |
| `lilo.publish(topic, payload)` | the plugin bus, but only for topics declared in `publishes` |
| `lilo.exec(program, args)` | runs one binary the manifest declared as `exec:<program>` (`args` is an array of strings), without a shell, with the host's minimal environment, a 15 s budget and 64 KiB of output per stream; a leading `~` in an argument expands to the user's home, and the result is `{ code, stdout, stderr }` |
| `lilo.desktop(operation, args)` | JSON string containing a scoped desktop result. `apps` lists opaque IDs and names; `open` launches a catalog app specified by `args.app`; both require `desktop:apps`. `type` inserts `args.text` into a supported field in that named app and requires both `desktop:apps` and `desktop:text`. Errors are `{ok:false,error:{code,message}}`; paths and dictated text are omitted from results. The method exists only when a desktop capability is declared. |
| `lilo.platform` | `"macos"`, `"windows"` or `"linux"` — pick the right tool per OS without shipping a file per OS |
| `lilo.temp(name)` | a path under the plugin's scratch folder for a tool it runs to write to; bare file names only |
| `lilo.readBase64(path)` | the bytes of a scratch file as base64 — the way binary output (a JPEG, a PNG) reaches JavaScript; reads are confined to the scratch folder and capped at 6 MiB |
| `lilo.screenshot(maxEdge)` | the primary screen as a base64 JPEG, long edge at most `maxEdge` px, captured in-process (no child process an antivirus could block); defined only for a plugin that declares `screen:capture`, and built in on Windows only — elsewhere it throws, so use the system tool |
| `lilo.log(message)` | the host log, prefixed with the plugin id |

There is no Node `require`, browser `fetch` or unrestricted `fs`. Network and
filesystem access use permission-scoped host APIs such as `lilo.http` and local
storage. The manifest grants each machine operation:
`lilo.exec` runs a declared bare program name without a shell, while
`lilo.desktop` validates the installed application and target field through
the native backend. Neither desktop operation interprets user text as code.
Binary output comes back through the scratch folder: a tool writes a file, and
`lilo.readBase64` reads it. Each plugin gets its own runtime on its own thread,
a 32 MB heap ceiling and an interrupt handler that ends a script that will not
return (60 s per call), so one bad plugin cannot hang or exhaust the host —
which is what makes marketplace code reviewable.

A plugin may also call `lilo.publish` while it is still loading: the event
waits until `describe` has declared the topic and goes out the moment the host
connects its publisher. The pomodoro re-arms its countdown that way, so a
running timer shows up again after a restart. Publishing an undeclared topic
after the load throws (the call fails, the plugin keeps running).

`tick` is how a plugin keeps its own clock: the pomodoro example stores
`endsAt` in `data/state.json` and checks it in `tick`, so a restarted plugin
picks a running timer up where it left off. Timers are not host callbacks and
do not survive an uninstall.

## Protocol (process runtime)

One JSON object per line on stdin/stdout. The host starts the process with its
working directory set to the plugin folder, which is the only place it should
write.

The process gets a **minimal environment**, not the host's: `PATH`, `HOME`,
locale and temp variables (plus what Windows needs to start a program), and
`LILO_PLUGIN_ID`, `LILO_PLUGIN_DIR`, `LILO_PLUGIN_API`. A user's shell may hold
API keys; a marketplace plugin does not get to read them.

```text
host → plugin  {"id":1,"method":"describe","params":null}
plugin → host  {"id":1,"ok":true,"result":{"tools":[…],"commands":[…],"ui":{…}}}
host → plugin  {"id":2,"method":"invoke","params":{"tool":"hello_greet","args":{"name":"Ada"}}}
plugin → host  {"id":2,"ok":true,"result":{"greeting":"hello, Ada"}}
host → plugin  {"id":3,"method":"configure","params":{"greeting":"hi"}}
```

* A reply whose `id` does not match is ignored — a plugin may emit its own
  events without desynchronising the stream.
* `ok:false` with an `error` string is reported to the user as-is.
* The handshake has a 10s budget, each call 60s. Overrunning it is an error,
  never a hang. A line longer than 4 MiB is refused.
* `shutdown` is sent before the host stops a plugin (uninstall, update), with a
  short grace period to flush files. Then the process is killed regardless.
* A plugin that crashes or hangs is restarted on its next call: `describe`
  again, then its last settings through `configure`. Three restarts within a
  minute and it stays down until LILO restarts. The last lines of its stderr
  are included in the error, so a crash explains itself.
* The process dies with the plugin (`kill_on_drop`); an orphaned plugin would
  keep running with nothing able to stop it.

## What a plugin can declare

**Prompt** — one short paragraph (`"prompt"` in the `describe` result) telling
the model what this plugin lets LILO do. It is added to the briefing the
assistant receives, so "what can you do?" includes the plugin. Untrusted text:
the host flattens it to one line and caps it at 600 characters. A plugin that
declares none is still briefed: the host writes the line from its tools'
descriptions (same flattening and cap), or says it is installed with no voice
abilities.

**Tools** — name, description and a JSON Schema for the arguments. They appear
in Settings and in the model's briefing, and are callable by voice through the
commands below.

**Commands** — spoken phrases, so a plugin is reachable without a UI:

```json
{
  "name": "notes.clear",
  "scope": "tool",
  "tool": "notes_clear",
  "requiresConfirm": true,
  "descriptions": [["en", "Delete every note."]],
  "templates": [
    ["en", "clear my notes"],
    ["pt", "apaga minhas anotações"]
  ]
}
```

Template language: `word`, `[optional|group]`, `(required|alternative)`,
`{free text slot}` and `<name>` (the assistant's name, from the wake phrase).
`requiresConfirm` parks the command and asks the user before anything runs.

A broad phrase can be kept from claiming unrelated speech with `slotWords`:
the slot only matches when it contains one of the words.

```json
"templates": [["en", "make it {mood}"]],
"slotWords": { "mood": ["rain", "snow", "sun"] }
```

A phrase that carries no free text can still tell the tool what it means with
fixed `args`, merged under any matched slot:

```json
{
  "name": "weather.off",
  "tool": "weather_mood",
  "args": { "mood": "off" },
  "templates": [["en", "(turn|switch) off the (background|effect)"]]
}
```

A result with a `summary` string is what the transcript shows and what the
model is told happened.

**UI** — declarative, rendered by the host with its own controls. No HTML, no
JavaScript: the app's CSP forbids remote content, and an iframe would hand a
marketplace plugin a browser surface nobody reviews.

```json
"ui": {
  "settings": [{ "key": "max", "kind": "range", "label": "Max notes", "min": 1, "max": 50 }],
  "status":   [{ "label": "Storage", "value": "notes.txt", "state": "ok" }],
  "actions":  [{ "label": "Read notes", "tool": "notes_list" }]
}
```

`kind` is one of `text`, `password`, `switch`, `select`, `range`. A setting
may carry a `default`, used until the user changes it.

**List** — rows that change while the plugin runs (recent songs, saved
items). The description names a tool, never the rows:

```json
"ui": { "list": { "title": "Recently played", "tool": "history_list",
                  "empty": "Nothing played yet." } }
```

The tool returns `{"items": [{"label", "detail", "action": {"label", "tool",
"args"}}]}`; `detail` and `action` are optional, and an action runs one of the
plugin's tools like any other button. A row may also carry
`"image": {"file", "mime"}`: a picture the plugin wrote as base64 text into its
own `data/` folder (`lilo.write`). The host reads that file itself
(`crates/lilo-core/src/plugins/images.rs`, with the same confinement as
`lilo.read`) and draws a thumbnail that opens full size, so a gallery never
holds its pictures in the plugin's bounded heap. `mime` is one of `image/png`,
`image/jpeg`, `image/webp` or `image/gif`; anything else is not drawn. The page reads the list when it opens,
after any of its actions, and whenever the plugin publishes an event — publish
something (the history example sends `history.changed`) to refresh an open
page. Rows without a `label` are dropped.

Declaring any of these — settings, status, actions or a list — gives the
plugin **its own page in the settings navigation**, named after the plugin. The
Plugins page only lists and manages plugins; plugin UI never piles up inside
it.

**Scene** — a background behind the voice stage (weather, a mood):

```json
"ui": { "scene": { "tool": "weather_scene", "everySecs": 60 } }
```

The host calls that tool now and every `everySecs` (at least 15), and applies
the `scene` of *any* tool result, so a voice command changes the background at
once. The result is `{"scene": {"kind", "intensity", "night"}}` with `kind` one
of `none`, `clear`, `sun`, `clouds`, `fog`, `rain`, `snow`, `storm`, `heat`,
`cold`. The host draws it; a plugin never ships drawing code, and anything
outside the vocabulary draws nothing. One scene is shown at a time. A description
the host cannot render (a `select` with no options, an inverted `range`) fails
the load with a named reason instead of rendering a broken page.

Settings values are owned by the host (`<app data>/plugins/<id>/settings.json`)
and pushed to the plugin over `configure`: once right after the plugin starts,
and again on every change, so a change applies without a restart.

**Mood** — an expression on LILO's face, shown for a few seconds then faded
back. Unlike a scene it needs no `ui` declaration or polling: the host applies
the `mood` of *any* tool result the moment that tool runs, the same way it
applies a `scene`. A result of `{"mood": {"kind": "happy"}}` shows that
expression; `kind` is one of `happy`, `sad`, `angry`, `surprised`, or
`neutral` to fade back to the resting face early. The host draws it, and a
value outside the vocabulary is ignored. Between tool results the host reads a
mood from the conversation itself (`app/src/store/moodCues.ts`); a mood a tool
asked for outranks it while it shows.

**Vision** — a picture the assistant may look at, like a screenshot:

```json
{"summary":"looked at your screen",
 "screen":{"data":"<base64>","mime":"image/jpeg",
           "text":"The attached image is the user's screen."}}
```

The host removes the `screen` field from the tool result and delivers the local
image to the main UI through the vision channel. The active adapter owns any
remote upload or video delivery; capturing a screenshot never requires another
provider's account. For ChatGPT, only its adapter uploads the image through the
current voice session and relays the returned file pointer. Image bytes stay out
of logs and model text. A provider with `outbound.image` can receive the frame;
otherwise the app reports that the image cannot be shown. The `screen` example
is the bundled capture plugin.

**Play** — a song for LILO to play:

```json
{"summary":"playing again: Ordinary","play":{"track":"Ordinary","artist":"Alex Warren"}}
```

The host takes `play` out of the result and runs it through `media_play`, the
same search as "play <song>" by voice. Only `track` and `artist` cross over:
a plugin names a song and never hands the player a URL or a file. A replay
during a call ends the call exactly as a spoken request does.

**Imagine** — a picture for the voice backend to draw:

```json
{"summary":"creating a picture: a blue whale","imagine":{"prompt":"a blue whale"}}
```

The host takes `imagine` out of the result and passes the prompt (at most 500
characters) to the live session (`app/src/store/imageRequests.ts`). A backend
declaring `inbound.images` is asked in a hidden turn, LILO shows a "creating
the picture" thought until the picture arrives (see `image.created` below),
and any other backend is told to say it cannot. Outside a live call the user
is told to start one. The `gallery` example is the bundled command.

## Events between plugins

### Conversation memory and opening context

A plugin may declare `contextTool` in `describe`, naming one of its own
read-only tools. The host does not run it automatically at voice connection.
Instead, declare a voice command that routes the relevant user request to the
owned read tool. When its result includes `{ "context": "..." }`, the host
quotes that selected data as untrusted context and asks the active provider to
answer the request using it. The same path works for every provider, including
ones without native function calling. Keep private data in `context`, separate
from the short human-facing `summary`; bound the returned context to the data
needed for that command. A lookup failure does not block the voice session.

To observe spoken evidence, declare `conversation:read` in the manifest and
subscribe to `conversation.turn` and/or `conversation.ended`. A turn carries
`{sessionId, at, turn: {id, speaker, text, final}}`; an end carries
`{sessionId, at}`. Only host-origin events are delivered. The permission is
required even for wildcard subscriptions. These topics are ephemeral and
never mirrored to UI windows. Each subscriber has a 500 ms delivery budget,
so a stalled plugin cannot indefinitely delay command routing or disconnect.
Consumers must upsert revisions by session and
turn id and choose when recording is appropriate. The headless daemon emits
finished transcriptions through the same event contract.

The bundled `study` plugin uses this contract to build local learning memory
and support daily language-study continuity. See [Language study](language-study.md).

Plugins never call each other. They publish and subscribe to **topics** through
the host, so a publisher does not need to know who listens, and either side can
be uninstalled without breaking the other.

Declared in the `describe` result:

```json
{ "subscribes": ["location.changed"], "publishes": ["notes.*"] }
```

* Deliver: the host sends `{"id":7,"method":"event","params":{"topic","payload","source"}}`.
* Publish: write a line `{"publish":{"topic":"notes.added","payload":{…}}}` at any
  time, including between calls: the host reads a plugin's output continuously,
  so an event goes out the moment it is written. Topics outside `publishes` are
  dropped.
* General topics are **retained**: the last event of each topic is kept, and a plugin
  that subscribes later gets it right after loading.
* `location.*` matches every `location.` topic; `*` matches everything.
* A plugin never receives its own events. General events are also mirrored to the
  UI as `lilo://plugin-event`. `conversation.*` events are private, ephemeral
  and delivered only to authorized subscribers, as described above.

Published by first-party plugins:

| Topic | Publisher | Payload |
| --- | --- | --- |
| `location.changed` | `lilo.location` | `latitude`, `longitude`, `name`, `country`, `timezone`, `source` (`manual`/`device`/`network`), `accuracyKm` |
| `media.playing` | `core.media` | `id`, `title`, `artist`, `url`, `durationSecs` — once per track that starts, including the queue moving on by itself |
| `image.created` | `host` | `id`, `prompt`, `mime`, `data` (base64), `width`, `height`, `provider`, `createdAt` — a picture the voice backend made in the conversation (only a backend declaring `inbound.images`) |
| `image.show` | A picture plugin | `file`, `mime`, optional `prompt`, or `items` containing those fields — show stored pictures in LILO's thought bubble. Files are read from the publishing plugin's own `data/` folder through the host. No live call is required. |

For `image.show`, the desktop displays at most eight pictures in order, six
seconds apart, and keeps the last picture visible for twenty seconds. A new
request replaces the sequence; dismissing a picture, receiving a newly
generated picture, or starting image generation cancels it. Unreadable files
are skipped. Headless hosts leave display events to connected interfaces.

Each pictured list row and its full-size viewer has a Download button. The
desktop host validates and decodes the plugin's stored picture, saves it in
the operating system's Downloads folder, and reports the saved path. Existing
files are preserved by giving subsequent copies a numbered suffix.

### Telling the user something

`notify` is the one topic the host itself acts on. A plugin that declares
`"publishes": ["notify"]` can speak up on its own — a timer that ran out, a
download that finished:

```json
{"publish":{"topic":"notify","payload":{"summary":"Focus done. Take a 5-minute break."}}}
```

The app shows `summary` as a toast and plays a chime; during a live call on a
backend with a text channel, the assistant also says it. `"chime": false` and
`"speak": false` turn those off. The summary is flattened to one line and capped
at 300 characters.

### A countdown in the menu bar

`statusbar` puts a short label in the system menu bar (the macOS status area,
next to the clock). With `endsAt` (Unix seconds) the host counts down on its
own, once a second, so the plugin publishes only when something changes:

```json
{"publish":{"topic":"statusbar","payload":{"label":"Focus","endsAt":1789850000}}}
{"publish":{"topic":"statusbar","payload":{}}}
```

A paused countdown sends `left` (seconds) instead of `endsAt` and is shown
without ticking. `actions` (up to six `{label, tool, args}`) become the item's
menu, both in the menu bar and on the timer chip in LILO's top bar; the host runs
an action only when the publishing plugin owns that tool:

```json
{"publish":{"topic":"statusbar","payload":{"label":"Focus","endsAt":1789850000,
  "actions":[{"label":"Pause","tool":"pomodoro_pause"},{"label":"Reset","tool":"pomodoro_stop"}]}}}
```

An empty payload removes that plugin's item. Each plugin owns one item; the most
recently published one is shown. Labels are capped at 24 characters. The menu
always ends with "Open LILO". A headless host ignores the topic.

### Ending the voice call

A tool result with `"endSession": true` ends the live voice session once the
tool has run — the pomodoro uses it so that starting a focus stops LILO
listening. The wake word stays on.

`lilo.location` (`crates/lilo-core/src/location.rs`) takes the device fix the
UI reports, falls back to a keyless IP lookup, and lets a typed city override
both. `lilo.weather` subscribes to it.

## Marketplace

A public repository is one flat folder: `index.json` beside one folder per
plugin. There is no second copy of anything — `examples/plugins` in this
repository *is* the marketplace, index included. Desktop development (`npm run dev`) reads only the workspace's
`examples/plugins`, even if a remote `marketplaceUrl` was previously saved.
No repository request is made in development. Packaged release builds use the
configured source; an empty `marketplaceUrl` selects this repository's folder,
served raw by GitHub (`settings::REPO_MARKETPLACE_URL`). When that default source
cannot be reached (offline or a network failure), the copy bundled under the app's
resources `plugins/` directory answers instead.

```
index.json
hello/plugin.json
hello/hello.js
notes/…
```

`index.json` lists every plugin and **every file with its SHA-256**:

```json
{
  "plugins": [
    {
      "id": "com.lilo.hello",
      "name": "hello",
      "version": "1.0.4",
      "api": 1,
      "path": "hello",
      "entry": "hello.js",
      "files": [
        { "path": "hello.js", "sha256": "68515c…" },
        { "path": "plugin.json", "sha256": "7310bf…" }
      ]
    }
  ]
}
```

The index mirrors `entry`, `platforms` and `hosts`; the manifest inside the
folder is authoritative for `runtime`. Generate it with
`scripts/build-marketplace.sh` and commit it. A test fails when the index and
the files disagree. `data/` and `settings.json` belong to the user: they are
never listed and an update preserves them. Catalogs omit plugins unsupported
by the current operating system or host, and installation refuses mismatches.

Settings → Plugins has the URL:

* production — `https://raw.githubusercontent.com/<owner>/<repo>/main`
* local simulation — a folder path (or `file://…`), e.g.
  `examples/plugins` in this repository

Install, update and uninstall are the same code path in both cases: stop the
running copy, download, verify every digest, check that the downloaded
`plugin.json` has the id, version and api the index promised, stage, then swap.
A failed install leaves nothing behind and never a half-written plugin, and the
previous version is started again. Only one plugin operation runs at a time.

An HTTP marketplace must be `https://` (plain `http://` only for localhost):
digests travel with the index, so over plain HTTP anyone on the network could
rewrite both. "Update available" means a *newer* dotted version, never a
downgrade. An update replaces the folder rather than
merging, so no file from the old version survives — but `data/`, `settings.json`
and a deactivation are carried across, because those belong to the user, not to
the package. A plugin keeps its notebook and its configuration across versions,
and if the swap itself fails they are moved back before anything is cleaned up.

A plugin's own storage is `data/` inside its folder; its settings file sits at
the root and is written only by the host.

A plugin can also be **deactivated** without being uninstalled: the host writes
`.disabled` inside its folder and the loader skips it, so nothing starts — no
tools, no voice commands, no page. The folder, its data and its settings stay
exactly where they were, so activating it again returns the plugin the user had.
Uninstalling removes the folder and everything in it, which is what makes it the
destructive option; first-party in-process plugins have no folder, so they are
always on and cannot be deactivated.

Settings → Plugins shows both lists: install, update and uninstall from the
catalog; activate, deactivate and uninstall on the installed side. Settings →
Storage shows what each installed plugin occupies and what the host process
itself costs (memory, CPU, threads, uptime), so "is this plugin worth it?" has
an answer with numbers.

### Known gaps

* **A process plugin is not sandboxed.** Its `capabilities` are declared and
  shown, but a process can still do anything its user account can; real
  enforcement needs an OS sandbox per platform (AppContainer, `sandbox-exec`,
  Landlock/seccomp). The quickjs runtime is the sandboxed path and is the
  default for that reason.
 * **QuickJS networking is permission-scoped.** `lilo.http(url, options)`
  reuses the native HTTP client for exact declared `http:<domain>` destinations.
  It enforces redirect permissions, UTF-8 body/output and time/byte budgets.
  See [HTTP and host discovery](plugin-authoring.md#http-and-host-discovery).

* **Status rows are static.** They come from `describe`; a plugin cannot push a
  change ("connected" → "expired") yet. The planned shape is an unsolicited
  `{"event":"ui"}` line, which the id matching already tolerates.
* **Password settings are stored in plain text** in `settings.json`, like every
  other setting. The OS keychain is the fix.
* **A process plugin needs one entry per OS.** `.sh` on macOS/Linux, `.ps1` on
  Windows; a quickjs plugin needs exactly one file everywhere.

### Trust, stated plainly

Digests make a corrupted or truncated download impossible to install. They do
**not** make a hostile index impossible — whoever controls the index controls
the digests. Publisher signatures (Ed25519 over the index, public key pinned by
the host) are the next step, and are a prerequisite for installing third-party
plugins without review.

## Examples

Every bundled example is a single `.js` file on the quickjs runtime.

* `examples/plugins/hello` — the minimum: one tool, one command, a settings
  form (both settings actually change the answer), a status row and an action.
* `crates/lilo-core/src/weather.rs` — first-party, in-process: live weather as
  a background scene, voice moods with `slotWords`, setting defaults.
* `examples/plugins/notes` — a voice notebook: three tools, a destructive
  command behind `requiresConfirm`, and everything stored in its own folder.
* `examples/plugins/pomodoro` — focus timers that announce themselves: it
  publishes `notify` when a phase ends, with no call in flight, from its own
  `tick` clock. State lives in `data/state.json`, so a restarted plugin
  re-arms a running timer.
* **Computer control** (`lilo.computer`) — bundled application opening on
  Windows, macOS and Linux desktops. No plugin install, app paths or MCP server
  configuration is needed. Say `LILO, open VS Code`, `open Chrome`,
  `open Teams`, or `list installed applications`. Common aliases cover
  browsers, editors, communication apps, office apps, terminals and file
  managers. Exact installed names take priority; ambiguous names are refused.
  The local catalog is cached briefly and refreshed on a lookup miss, so newly
  installed common apps can be found without restarting. Windows includes
  packaged apps from Shell AppsFolder. The settings switch disables both
  discovery and opening. Headless sessions return an unavailable result.
  This provider has application-opening permission only; it cannot type, read
  files or run shell commands supplied by the user.
* `examples/plugins/desktop` — experimental, opt-in text entry for Windows,
  macOS and Linux. Install **Desktop control** from Settings → Plugins, then
  say `open my VS Code` or `open application Notepad`. Select a text
  field in your target app and say `in my VS Code write Hello, world!`,
  followed by `confirm` or `cancel`. The trailing `{!text}` slot preserves the
  original caption's case, punctuation and accents. Confirmation expires after
  one minute; a replacement request invalidates the previous one. UI buttons
  remain available, and only a final user caption can approve an action.
  macOS uses Accessibility permission and `AXSelectedText`; Windows uses UI
  Automation with field-specific edit insertion (modern empty fields only when
  no insertion API is available); Linux uses `gio` and `gdbus` with AT-SPI in an
  existing graphical session. Linux text entry needs a running target with
  accessibility enabled. Missing services, password fields, ambiguous targets
  and unsupported fields return errors. No clipboard, global keystrokes or
  implicit submission is used. The plugin stores no dictated text, and its
  action results omit it; the voice provider and normal conversation history
  still receive the original utterance. Headless installations can load the
  plugin, but desktop operations require a graphical session. Natural launch
  phrases are constrained to the installed catalog; possessives and known aliases
  resolve to the installed application. Update installed plugins from Settings after upgrading
  their bundled versions. Creating files and correcting code need an editor
  integration and are not supported by this launch/dictation plugin.
* `examples/plugins/screen` — looks at the screen: it branches on
  `lilo.platform` to run `screencapture` + `sips` (macOS), `grim`/
  `gnome-screenshot`/`spectacle`/`import` (Linux) or PowerShell (Windows),
  writes the frame into its scratch folder, reads it back with
  `lilo.readBase64` and returns the vision result above. Its own Settings page
  carries the "Allow screen recording" action, so the user grants macOS's
  permission from the plugin's menu — the host never captures anything by
  itself.
* `examples/plugins/history` — the songs LILO played: it subscribes to
  `media.playing`, keeps the newest first in `data/history.json`, shows them
  as a live `list` with a replay button per row, and replays through the
  `play` result — it never touches the player.
* `examples/plugins/gallery` — every picture LILO was asked to make: it
  subscribes to `image.created`, writes each picture into `data/img/` and lists
  them with an `image` per row, a delete button each, and a "clear" voice
  command behind `requiresConfirm`. Voice commands show the latest stored
  picture or the eight newest pictures in sequence through `image.show`.
  It never talks to a backend: asking for a
  picture goes to the voice backend, which makes it.

## Names and descriptions

`plugin.json` owns the plugin’s display `name` and optional `description`.
An optional `localized` object maps UI language codes to `{name, description}`
pairs. The catalog builder copies this metadata into `index.json`; installed
plugins retain it in their manifest. The desktop uses the current UI language
for labels and explanations, falling back to the base metadata for older or
third-party plugins. The host never selects labels by plugin id. Rebuild with
`node scripts/build-marketplace.mjs` on any OS, or the POSIX wrapper
`sh scripts/build-marketplace.sh` on macOS and Linux.

## Headless

A plugin that ships a UI still runs with no display: the description is
optional, and the headless Linux device daemon ignores it. Nothing in the contract
requires a window.

## Durable QuickJS primitives

`lilo.memory` exposes `read`, `write` and `delete` with plugin-owned schema
versions, optional revision guards and explicit backup recovery. The reserved
`.lilo-state` namespace cannot be reached through raw `read`/`write`. Limits:
32 records of at most 4 MiB each. Forgetting must use `purgePrevious: true` or
`delete` so successful cleanup cannot recover private evidence from a backup.
Writes stage, flush and rename; filesystem durability still applies.

`lilo.schedule` exposes `put`, `list` and `cancel`. Tools must belong to the
plugin, jobs are capped at 32 and arguments at 8 KiB. Jobs survive restart;
missed policies are `runOnce` or `skip` (over 60 seconds late), without replaying
missed intervals. A durable claim precedes invocation: at-most-once attempts,
with possible lost delivery after a crash, not an exactly-once guarantee.
Callbacks publish their own output. LILO and the plugin must be running;
notifications do not start a new voice call. Calendar rules stay in JavaScript.

The complete options, semantics, migration examples and runtime distinction
are documented in [Plugin authoring](plugin-authoring.md#durable-memory-and-scheduled-work).
The [daily vocabulary review](../examples/plugins/vocabulary-review/) is a
voice-only, offline scenario covering both APIs without feature-specific host
logic. Existing `study` and `dictionary` import their legacy storage on hosts
with atomic memory. Process plugins do not expose these native QuickJS calls.

Multiple live sections may be declared with `ui.lists`; the original `ui.list`
remains supported. Together they are limited to eight lists. Static UI tools
must be owned by the declaring plugin in both runtimes. See the author guide
for descriptor and rendered-row budgets.

The declarative page contract also supports bounded `cards`, `progress` and
`forms`. Every source and submit tool must belong to its plugin. Destructive
static actions declare `requiresConfirm: true`; dynamic deletes always ask.
See the author guide for row, field and payload limits. Dynamic row actions
are checked against the emitting plugin's owned tool list before rendering.

## Voice provider extensions

Plugins can declare `voiceProviders` alongside tools and commands, using the
private provider lifecycle instead of exposing connection controls as model
tools. See [the provider plugin contract](provider-plugins.md). The Qwen example
implements its own vendor protocol, with desktop-owned media and an isolated
browser. Commands remain in the shared router for every provider that delivers
user captions. Images and other media still require declared transport support.
