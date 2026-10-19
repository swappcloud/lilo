# Voice providers as plugins

Providers can be discovered from installed plugins. Installing or updating a provider does not require editing the frontend composition root. Disabling or removing a plugin disconnects its active media. A saved plugin selection and its options survive startup while plugins load; an unavailable plugin stays unavailable instead of silently choosing another account.

The extension uses the existing QuickJS and process runtimes. The core contract lives in `crates/lilo-core/src/plugins/voice.rs` without a Tauri dependency. Desktop capture and playback remain in the main window. The daemon has a separate standalone ChatGPT browser/audio path, controlled through phone management. That does not make third-party provider-plugin voice declarations, browser ports or media transports available on the daemon; installing a provider plugin alone does not add host support.

## Declarations

The manifest must grant `provider:voice`. `describe()` may return up to eight `voiceProviders`, separate from tools and commands:

```js
function describe() {
  return {
    voiceProviders: [{
      id: "web",
      label: "Example web voice",
      description: "Voice through the user's own web account.",
      transport: { kind: "pcm", inputSampleRate: 16000, outputSampleRate: 24000 },
      protocol: {
        inbound: { userText: true, assistantText: true, nativeToolCalls: false, images: false },
        outbound: { text: true, stopSpeaking: true, systemPrompt: true, toolResult: false, image: false }
      }
    }]
  };
}
```

A local provider id contains ASCII letters, digits, underscores or hyphens, at most 64 characters. The host assigns `plugin:<plugin-id>/<local-id>`; plugins cannot replace a native provider. PCM sample rates are 8, 16, 24 or 48 kHz. Transport kinds:

- `pcm`: the host captures mono PCM16 and plays returned PCM16 chunks. Capture and playback rates can differ. Audio is base64, not a filename or build path.
- `webrtc`: the host creates the peer and microphone track; the plugin negotiates the offer and translates frames. `channelLabel` defaults to `oai-events`. Set `remoteChannel: true` when the server creates the named channel. The host offers a negotiation channel to include SCTP, then binds only the declared remote channel.
- `host`: `{ kind: "host", adapter: "..." }` reuses an installed native adapter and its canonical account. It is a compatibility bridge, rather than a vendor protocol implementation.

`examples/plugins/provider-qwen` implements Qwen's web protocol in QuickJS. It
uses WebRTC with the server-created `txt` channel, vendor-owned session events,
spoken captions and reported quotas. It uses only the generic browser and voice host. Install **Qwen voice** from the marketplace, sign in under Accounts
for **Qwen (plugin)**, and select it in Provider. Its browser profile is separate
from any previously saved native Qwen account, so it requires its own sign-in. The plugin's
current default voice is Tina and its transport is audio-only. Qwen appears in Provider and Accounts only while its plugin is installed and enabled.

## Optional browser port

A QuickJS provider can declare:

```js
browser: {
  loginUrl: "https://fixture.example/auth",
  homeUrl: "https://fixture.example/",
  allowedHosts: ["fixture.example"],
  sessionProbe: "async () => ({ ready: false })"
}
```

Grant `web:fixture.example` as well as `provider:voice`. HTTPS origins must use
port 443, with exact declared hosts, no URL credentials or wildcard grants.
The desktop host allocates a stable private browser profile per plugin/local
provider. Its generic Accounts flow opens the real sign-in page; no host
changes are needed for another vendor. The session probe returns only
`{ready, name?, email?}` for readiness and public display identity. Cookies and
tokens are not copied into the main interface's account record.

`lilo.browser.call(providerId, functionSource, args)` runs that function on the
provider's declared browser origin and returns its object result. The function
can use the origin's session storage and same-origin fetch. The host checks
origin both before evaluation and inside the injected wrapper, including
navigation races. Scripts are bounded to 64 KiB; arguments to 512 KiB; browser
results to 128 KiB, with a 45-second request deadline. Vendor failures must be
translated to safe structured data in the plugin. Browser-port access is an
account-sensitive permission: review extensions before granting it.

A browser provider can declare `phoneForm` with `entry`, `entryText`,
`codeSwitch`, `codeInputs`, `phoneSwitch` and `codeNeedsFocus` (all optional).
The host renders the phone sign-in button only when this declaration exists.
The phone answers the real vendor page through the same LAN pairing server;
selectors belong to the plugin, while validation, step timing, origin checks,
challenge presentation, cancellation and account completion belong to the host.
Empty `phoneSwitch` means email sign-in only. Fields are bounded and never
persisted as plugin settings. Native backends retain their existing phone flows.

Process plugins can implement their own upstream
transport; the injected browser-call binding currently belongs to QuickJS.
Provider-plugin voice transports and the injected browser-call binding are
desktop capabilities. The daemon's standalone voice currently supports its
native ChatGPT path, not these plugin declarations.

Custom transports declare only capabilities they implement. Custom image
transport is not implemented; keep image capabilities false. Local screen
capture is a shared command, but sharing that image with a provider requires
its declared media transport. Authentication remains within the owning
plugin/profile; LILO never passes another provider's credentials into it.
Provider subscriptions and account limits apply separately.

## Private lifecycle RPC

A QuickJS provider implements `voice(request)`. Process plugins receive `{ "id": 1, "method": "voice", "params": request }` and answer with the existing `{ "id": 1, "result": {} }` envelope.

Requests contain `providerId` (local id), `sessionId` (host correlation id), `operation` and object `args`. These controls are never advertised to the model as tools. JSON requests and results are bounded to 512 KiB. The host opens a session before `connect`; later controls require that same live owner and session. The operations are:

| Operation | Arguments / result |
| --- | --- |
| `connect` | Connection settings, instructions, language and conversation context; WebRTC also receives `sdp` and must return `{sdp: "v=0..."}`. |
| `disconnect` | Release the upstream connection and session resources. |
| `audio` | `{audio: "<base64 PCM16>"}` for PCM input. |
| `text` | `{text, hidden}`; preserve the hidden-context intent. |
| `interrupt` | Cancel the current assistant response. |
| `event` | `{frame}` containing an incoming WebRTC data-channel string. |
| `toolResult` | `{id, result}` for a tool call supported by the declaration. |

The contract reserves `mute`, `input`, `output` and `image` for host integrations. Desktop microphone mute and device controls are applied locally. A WebRTC microphone change currently asks for a reconnect. Plugin calls must finish promptly: slow PCM input is bounded and causes a clean disconnect rather than an unlimited queue.

## Private voice output

QuickJS publishes through `lilo.voice.publish({providerId, sessionId, events})`. Process plugins write `{ "voice": { "providerId": "web", "sessionId": "...", "events": [...] } }` as a newline-delimited notification. This is separate from `lilo.publish` and the public event bus. Other plugins cannot subscribe to it. The host validates the owning live session, rejects unknown event types and bounds each output envelope to 64 KiB and 64 events. Delivery uses a bounded channel with no replay or retained speech. Overflow ends the desktop connection rather than dropping audio silently.

| Event | Fields |
| --- | --- |
| `caption` | Stable `id`, `speaker` (`user` or `assistant`), `text`, `final`. Reuse the id for streaming updates. |
| `audio` | `audio`, base64 mono PCM16 at the declared output rate. |
| `response_started` | Marks assistant playback; microphone capture respects the user's barge-in preference. |
| `input_started` | Stops current local playback when barge-in is enabled. |
| `state` | `state: "connected"` indicates the assistant response finished and input may resume. |
| `usage` | Finite `remainingSeconds`. |
| `quota` | `kind: "daily"`, optional epoch-millisecond `retryAt`. Do not invent a deadline. |
| `error` | A safe, user-facing `message`, without credentials or account payloads. |
| `frames` | `frames`, an array of outbound WebRTC strings or JSON objects. |
| `tool_call` | `id`, `name`, object `args`; only use when native tool calls are declared. |

Prepare the upstream transport in `connect`, handle explicit cancellation, and close network resources in both `disconnect` and plugin shutdown. The host opens PCM playback before requesting the first response, so early audio does not lose its first word. Do not persist microphone input, session tokens or captions unless a separately authorized feature needs them.

Direct PCM injection through `sendAudio` is supported by PCM plugin transports.
WebRTC plugins currently capture the selected desktop microphone and do not
advertise direct PCM injection. Neither plugin transport currently connects
the desktop LAN satellite pipe automatically.
