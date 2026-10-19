# Qwen web voice plugin (beta)

LILO uses the user's own account at https://chat.qwen.ai/. There is no paid
API, API key, local language model or local speech synthesis. Qwen controls
account availability, daily voice limits and session time limits.

## Observed web contract

The public Qwen web client identifies version
`0.3.12`. Its voice component and omni SDK include a WebRTC path:

- The page requests `POST /api/v2/users/user/audio_chat_token` with `type:
  AudioOnly`, `model_id: omni`, `mode: duplex`, `project_id: ""`, selected `voice`, audio SDP offer,
  timezone (`new Date().toString()`) and platform information. Authentication uses the site's current bearer
  token and cookies, within that same origin.
- A successful response contains an SDP answer in `data.sdp_token`, the
  generated `chat_id`, voice, remaining sessions and `audio_timeout`.
- The main LILO window owns the microphone, playback and `lilo-negotiation` offer channel. Qwen opens a separate server-created `txt`
  channel for session events and session.update; waiting on the offer channel
  causes a handshake timeout. Direct realtime events carry `session.created`, `session.update`,
  audio transcriptions, response transcripts and interruption. These are not
  ChatGPT WM's wrapped `data_message` events.
- The observed session update enables audio/text, semantic VAD and
  `qwen3-asr-flash-realtime` input transcription. LILO keeps the server's negotiated
  turn detection because an authenticated account rejected the explicit semantic
  VAD override with `invalid_request_error` for `turn_detection`. LILO sends its opening
  conversation context through the session's instructions.

Sources are Qwen's own public client assets, not third-party API instructions:
[web client](https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.12/js/main.js),
[voice component](https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.12/js/index-Cf5gd0Cr.js),
[omni transport](https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.12/js/qwen-chat-omni-sdk-vendor-DVoDTvDO.js).
These are undocumented web interfaces and may change.

The web SDK submits the offer without waiting for ICE gathering, applies
`data.sdp_token` as the remote answer, then enables media after
`session.created` on `txt`.

## Boundaries

The adapter is beta until a real signed-in voice session is validated.
Local tests validate request shapes, credential isolation, handshake,
streamed captions, microphone cleanup and cancellation. They do not prove
account availability or server acceptance of every optional session field.

Qwen also has an older Aliyun RTC transport, selected when no SDP answer is
returned. LILO fails clearly on that response; it does not download or embed
that SDK. An exhausted voice allowance also fails without logging account
response data. Credentials remain in the provider WebView. Login callbacks export only bounded
name and email for the local account display; SDP callbacks export only transport
data. No credential token or cookie is copied into the account record.

Voice selection uses the public Omni catalog snapshot in
`examples/plugins/provider-qwen/provider.js`: 54 voice IDs from
`GET /api/v2/tts/config` with `omni_speakers=v1`, `audio_tts_speakers=v1`,
`omni_language=v1`, and `audio_tts_language=v1`.
Default: `Tina`. Vendor names with spaces and Unicode are preserved; the
selected voice is sent when a new session starts. Image generation, native
function calls and remote chat history import are not advertised.
Sign-in uses the plugin's isolated embedded browser. Version 0.1.1 declares phone-assisted email sign-in through the shared LAN pairing page; verification codes fill the real segmented Qwen inputs. Previously saved native Qwen accounts are retained locally but are not used or displayed as active providers.

Local LILO history and context remain managed by the generic
conversation store. Qwen's current web voice request creates a server chat;
resuming the same remote chat is not established by the inspected contract.
A new call must therefore not be described as remote chat synchronization.

The same desktop implementation runs on Windows, macOS and Linux without
external binaries. Browserless headless voice is not supported by this web
adapter; it requires the desktop WebRTC runtime, like the web login itself.

## Live validation

Use the app, not a browser test harness. Sign in through Settings, select
Qwen, start a voice session and verify the first spoken word, streamed
captions, turn taking, interruption, mute, device selection and disconnect.
Repeat after restarting LILO and switching from another provider to verify
that the local conversation context continues. Repeat sign-in through both the plugin browser and the phone pairing page; verify cancellation and refused credentials do not complete sign-in. Check an unavailable or
exhausted account fails clearly. Repeat on all three desktop platforms before
changing the release stage from beta to tested. Never capture credentials,
private response payloads or personal paths in a fixture or screenshot.

### Spoken captions and internal context

LILO follows audio transcript events for captions rather than exposing a complete
text response before playback. Both incremental `delta` events and confirmed
`text` segments with a revisable `stash` are assembled into one bounded turn.
The latter format is documented in Alibaba Cloud's
[server event reference](https://www.alibabacloud.com/help/en/model-studio/live-translator-server-events).
Actual timing remains determined by the web service's emitted events.

Hidden LILO context updates session instructions without requesting a response.
Explicit user text still creates a conversation item and requests a response.
This prevents startup persona, language, and command notes from each generating
unsolicited speech. The original instructions and up to eight bounded recent
notes are retained for the session.

This adapter negotiates audio only. The screen plugin can capture the desktop,
but Qwen cannot analyze that image through the current transport. WebRTC visual
input requires a negotiated video track; sending a websocket-only image event
on this channel would not establish image support.


## Installable provider acceptance check

Install **Qwen voice** from the marketplace, then sign in to **Qwen (plugin)**
in Accounts. This profile is separate from previously saved native Qwen accounts. Select the
plugin in Provider and pick a voice; the plugin owns its catalog and protocol.

1. With available account quota, start a call and confirm the chosen voice.
2. Ask for a long reply: captions should follow emitted spoken transcript events,
   without displaying the complete generated response before playback.
3. Interrupt the reply, then leave the microphone quiet for a minute. Confirm
   the provider does not repeatedly respond to hidden local status updates.
4. Try an installed note or media command. Switch provider and confirm that old
   commands are not replayed into the new provider's conversation.
5. Request a screenshot. Capture uses the shared plugin command; this audio-only
   provider must not claim to have analysed the image.
6. End the call, disable the plugin and confirm microphone resources stop. Re-enable
   it and verify sign-in/voice selection remain available.

Repeat on Windows/WebView2, macOS/WKWebView and Linux/WebKitGTK. Local fixtures
and Linux core tests do not substitute for these real desktop voice checks.
Do not share session tokens or private conversation recordings with the project.
