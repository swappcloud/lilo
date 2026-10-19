# ChatGPT web voice — the protocol LILO speaks

ChatGPT's web client runs its realtime voice over WebRTC against
`chatgpt.com/realtime/wm`, authorized by the web session's `access_token`
rather than a paid API key. LILO drives that same path. It is undocumented
and can change without notice; the provider adapter
(`app/src/providers/chatgpt/`, `src-tauri/src/providers/chatgpt.rs`,
`src-tauri/src/gateway.rs`) is the only code that knows it.

> One user, their own account. LILO never pools or shares credentials.

## Where the media goes

```
main window (mic + RTCPeerConnection + DataChannel "oai-events")
      │  offer SDP
      ▼
hidden chatgpt.com window  ──  POST multipart(sdp, session), Bearer <access_token>
      │
      ▼
chatgpt.com/realtime/wm?dcid=0
      │  answer SDP ("v=0…")
      ▼
main window sets the remote description → media flows peer to peer
```

Only the SDP is relayed; audio never passes through LILO's Rust side. The
offer is posted *from the signed-in chatgpt.com window*, so it carries the
browser's own TLS fingerprint, cookies and Cloudflare clearance — a plain
Rust HTTP client gets fingerprinted and refused (`403`).

## The offer request

`POST https://chatgpt.com/realtime/wm?dcid=0`, `multipart/form-data` with two
fields:

- `sdp` — the offer, CRLF line endings, a trailing newline, starting with `v=0`.
- `session` — one JSON object (`gateway::build_session_json`):

```json
{
  "backend_reasoning_effort": "instant",
  "language_code": "auto",
  "requested_default_model": "",
  "voice": "cove",
  "voice_session_id": "<UUID>",
  "voice_status_request_id": "<UUID>",
  "timezone_offset_min": 0,
  "timezone": "<IANA zone>",
  "voice_mode": "wingman",
  "model_slug": "",
  "model_slug_advanced": "",
  "client_tools": [],
  "history_and_training_disabled": false,
  "conversation_mode": { "kind": "primary_assistant" },
  "enable_message_streaming": true
}
```

The time zone is the user's real one. Headers match the web client:
`authorization: Bearer <access_token>`, `oai-device-id` (stable per account),
`oai-client-version` (settings), `origin`/`referer: https://chatgpt.com`.

The answer is `200`/`201` with the answer SDP as `text/plain`. `401` means the
token expired.

## In-call messages (DataChannel `oai-events`)

Every message is an envelope around a **stringified** payload:

```json
{ "type": "data_message", "data": "<JSON string>" }
```

Outbound:

- a text turn — `{"type":"relay_message","payload":{"type":"relay_message","message":{…"author":{"role":"user"},"content":{"content_type":"text","parts":["hello"]}…}}}`
- barge-in — `{"type":"action_request","payload":{"action":"stop_speaking"}}`

Inbound: `chat_message_delta` carries caption text as it is spoken;
`relay_message` carries whole messages. Captions are assembled from the deltas.

## Generated pictures

A picture the assistant makes during the call reaches the conversation as a
non-user message part `{content_type: "image_asset_pointer", asset_pointer:
"sediment://file_…"}`; `app/src/providers/chatgpt/images.ts` looks for it in
every data channel payload and reads only the file id, the prompt and the
size. The host (`providers/chatgpt_images.rs` → `gateway.rs::download_image`)
asks `backend-api/files/download/<id>` for a signed link with the account's
bearer token, retrying for up to two minutes while the picture is drawn, and
returns the bytes as base64. The adapter declares `inbound.images`.

The adapter also accepts explicit `percent`/`percentage` or
`progress_percent`/`progress_percentage` fields in image-generation events
and metadata. It forwards these through the generic `onImageProgress`
provider callback; the thought bubble shows them only while an image request
is pending. This parser is defensive support, not a confirmed voice-channel
schema: delivery of those percentages still needs validation in the app.
The app does not estimate percentages from elapsed time or ambiguous numeric
`progress` fields; it keeps the normal waiting label when none arrives.

Whether the voice data channel relays the picture message at all is not
documented. The adapter logs each new payload outline once, as
`[chatgpt-web] data channel shape: <type> part:<content types> role:<roles>`,
with no words, so the log shows what arrived when a picture does not.

## Voices and modes

Voices: `cove` (default), `ember`, `breeze`, `fathom`, `glimmer`, `juniper`,
`maple`, `orbit`, `vale`. Modes: `wingman` (default), `standard`, `advanced`.
Both lists live in `app/src/providers/chatgpt/voiceCatalog.ts`.

## Token and session

The `access_token` is a short-lived JWT from `/api/auth/session`, which needs
the HttpOnly `__Secure-next-auth.session-token` cookie. LILO signs in through
an embedded `chatgpt.com` window; an injected same-origin script reads
`/api/auth/session` and reports through a `tauri-voice://` navigation that is
intercepted locally. The session cookie is captured at sign-in, so a token is
renewed later through HTTPS requests, without a window.

## Limits

Voice minutes are capped per account by the server (around two hours a day on
a free account). When the cap is hit LILO says so and stops; it never rotates
to another account.

## Durable conversation continuation

`voice_session_id` identifies a voice call; it is not the durable ChatGPT chat id.
The adapter captures `conversation_id` from `startup_telemetry` and
`conversation_update`, and the authoritative `parent_message_id` when supplied.
The next offer includes these fields as well as the remembered voice-call id.
The browser-bridge, native HTTP and external-gateway payloads carry the same
thread reference. An external gateway must support these additional fields.

This is an undocumented, best-effort transport. Observed event handling and
optional thread-continuation fields are not an official OpenAI compatibility
promise.
A real signed-in call must still verify that reconnecting appears in the same
chat on the website. Existing voice-call-only records cannot reliably identify
old remote chats and are not guessed from the user's most recent website chat.

Before reconnecting a known ChatGPT thread, `providers/chatgpt_history.rs` reads
`/backend-api/conversation/<id>` inside the signed-in host. It follows parents
from `current_node`, excludes alternate branches and system/tool messages, and
returns bounded text without tokens or account details. The adapter merges
these message ids into the local transcript. Refresh failure leaves local
history intact and adds a visible system message; it does not deliberately
create another remote chat. See [conversation history](conversation-history.md).


### Live caption rendering

The adapter emits native web caption snapshots and append operations immediately.
Its alternate `audio_transcript.delta` path preserves fragment whitespace and
message identity, and keeps fragments partial until the final snapshot arrives.
The speech bubble renders received text without an opacity or blur entrance.
Final-only replies also appear immediately and remain visible for reading.
Caption history saves are coalesced every 250 ms outside the immediate update
path, with an immediate flush on other persistent changes and page exit.
These checks cover local event handling and rendering; they do not establish
when the web service sends captions relative to its audio track.


### Playback onset and interruption

The local interruption detector starts its microphone hold window only while
the assistant is speaking; it must not reuse time accumulated during the user's
preceding utterance. Interruptions mute the live audio element without pausing
it, so decoding and stream draining continue before the next reply. Unit tests
cover these boundaries; audible onset still requires validation in the app.
