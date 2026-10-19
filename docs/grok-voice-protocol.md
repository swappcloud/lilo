# Grok web voice

## Validation status

Grok is **Beta** in the provider picker and Accounts, before sign-in. A live
voice session has not been confirmed for the reported Windows installation.
Follow-up validation is assigned in [issue #5](https://github.com/swappcloud/lilo/issues/5).
Do not promote an adapter to **Tested** on the strength of protocol or mocked
tests alone; record a successful live voice test and the platform tested.

The inspected public web client still uses the same web voice endpoint and
session setup as this adapter, so a fix appears technically plausible. That
observation does not establish that its private WebView session has equivalent
access to voice or that an account quota rejection can be bypassed. Diagnose
with web **voice** and LILO voice on the same account, after closing the web
session; identify quota, concurrency, authentication, and browser compatibility
separately. No resolution date is established.

Heartbeat replies echo `ping_timestamp`, matching the inspected web client.

Voice errors distinguish an active concurrent call (`concurrency_limit`),
request throttling (`rate_limit_exceeded`), and exhausted account allowances
(`usage_pool_exhausted` / `usage_limit_reached`). The engine reports a safe
message and immediately closes a refused socket. Unknown server details are
not forwarded. Check voice access with the same signed-in account when comparing
LILO with the website; text chat alone does not establish voice access.

The Grok adapter uses the signed-in `grok.com` website, without an xAI API
key or a paid API endpoint. Voice access and usage limits are determined by
the user's own Grok account.

## Login and credentials

`src-tauri/src/providers/grok.rs` declares a backend in the `WebBackend`
registry. Its private webview opens `https://grok.com/sign-in`.
`assets/grok-login.js` checks `/rest/auth/get-user` from the same origin
and reports only `tauri-voice://grok-session#ready`. Anonymous visitors are
not signed-in accounts.

Cookies remain in the provider WebView. The account file stores only bounded
name/email display metadata and a local web-session marker, never credential
tokens. Legacy markers remain readable when profile data is unavailable.

Phone login uses the shared LAN form driver. A label pattern opens Grok's
email form (including both "Continue with email" and "Login with email" labels), then the phone answers the visible email, password or code field.
The flow signs in to an existing account and does not create one. Social-only
accounts need a supported email/password login method. Captchas, age checks
and other interactive verification may require the PC. The shared phone
transport is HTTP on the same Wi-Fi; it does not encrypt submitted answers.

The phone code step brings Grok's native window into focus and uses the
browser's text editing path when supported, with the existing event fallback.
`code_needs_focus` belongs to the backend contract; other providers keep their
existing window behavior. `packages/phone-login/observer.js` records submission and
validation counts, pending writes and HTTP status without inspecting request
or response bodies. A DOM value alone does not establish successful login;
confirm the authenticated account callback with the user's real account.

## Socket and audio

The hidden Grok window owns the cookie-authenticated connection:

```text
wss://grok.com/ws/app_chat/stream_audio
  ?model=xai&client=oai&client_name=web&enable_search=true&voice=ara
```

Optional query fields are `conversation_id` and `x-app-language`. LILO stores
each conversation's upstream id per provider, so Grok is never handed a
ChatGPT or Claude id (the site's own client only resumes Grok ids). These
paths and shapes follow the public JavaScript served by `grok.com`; they are
not a stable vendor API contract.

On open, the engine sends `session.update` with `voice`, `playback_speed`,
`enable_vision`, `keep_context`, and `turn_detection: {type: "server_vad"}`.
LILO's context uses `instructions` with `is_raw_instructions: true`.
Connection succeeds only after `conversation.created` supplies an ID.

The main window captures and plays mono PCM16 at 24 kHz. Capture is divided
into 480-sample chunks (20 ms), base64-encoded and sent as
`input_audio_buffer.append`. Output arrives as `response.audio.delta`, with
base64 in `audio` or `delta`. The adapter acknowledges a played chunk through
`response.audio.delta.playback_completed`, preserving `response_id` and `rid`.
Binary frames carry UTF-8 JSON, like the site's own client.

Engine reports use `plugin:grok-voice|report`; its remote capability grants
only that command to the Grok window. Rust checks the window label, per-session
random token and report limits before forwarding `grok-voice` batches.
Cancellation removes the session and rejects reports from old engines.

## Captions and capabilities

User transcription updates replace a partial caption; only
`conversation.item.input_audio_transcription.completed` finalizes it.
Assistant captions use `response.audio_transcript.*` or `response.text.*`.
Audio transcripts take precedence when both channels appear. Playback can
be interrupted locally, and microphone mute releases its capture device.

A picture Grok makes in the conversation arrives as `response.grok.output`
with a `card_attachment`: a `generated_image_card` whose `image_chunk` carries
`imageUuid`, `imageUrl`, `progress` and the prompt. At `progress` 100 (and not
`moderated`) the engine fetches `imageUrl` from `https://assets.grok.com/` with
the page's own cookies, once per picture, and reports it as `image` events in
256 KiB base64 parts, each within one report batch. The adapter reassembles
them and emits `onImage`; the adapter declares `inbound.images`. LILO sends no
image request of its own: Grok's REST calls carry the site's anti-bot
signature (`x-statsig-id`), which LILO does not produce.

Text uses `conversation.item.create` followed by `response.create`.
The adapter declares native tool calls, image upload and usage reporting
unavailable. Account support requires the desktop webview; it does not supply
a browserless Grok transport to the daemon.

## App verification

Use `npm run dev` and test in the app on each desktop OS:

1. Sign in through the desktop window, then separately through the phone QR.
2. Start a session; confirm microphone, playback and both caption speakers.
3. Speak a multiword command and confirm it waits for the completed caption.
4. Interrupt speech, mute/unmute, switch supported audio devices and stop.
5. Reconnect, restart the app and confirm the saved browser session works.
6. Exercise unavailable voice access, usage limits and a dropped connection.

Automated tests cover protocol framing and lifecycle with mocks. They do not
establish account entitlement or compatibility with a live upstream rollout.

A page without a recognized form is reported separately from a detected challenge. Both reveal the desktop window while the phone keeps polling; only a detected challenge is described as a verification.

The account sign-in page can display email and password together. The driver
asks for the empty email first and does not submit an incomplete combined form.
When Grok offers “Email sign-in code”, it selects that existing vendor option
after filling the email, then asks the phone for the emailed code. Otherwise
it asks for the password. Disabled submit buttons remain pending until the
page enables them; automatic verification is not bypassed.
