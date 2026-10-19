# Spec: LILO daemon phone management

## Objective

Give a headless LILO daemon a persistent mobile web interface for supported
management and operation after the host has network access. The phone is the daemon's management interface; no desktop window is required.

First-boot Wi-Fi setup remains a separate legacy flow without physical hardware validation.
After the daemon is on the network, the phone shell can inspect available networks
and request a join through the device Wi-Fi manager.

## User flows

- Open and pair with the daemon management page from a phone once the host has
  network access.
- Inspect daemon health, network state, installed plugins, provider/account
  status, and safe operational messages.
- Browse the configured plugin marketplace; install, update, enable, disable,
  configure, invoke declared actions, and remove plugins.
- Manage wake phrase and locale settings from the phone.
- Start provider sign-in from the phone and see progress, challenge, success,
  and failure states. Credentials and session values must never be logged or
  returned in status responses.
- Keep local command routing usable when provider sign-in or the phone is
  unavailable.

## Contract and module boundaries

The existing monorepo keeps one React implementation of management pages.
`app/daemon.html` is an independent entry point and `DaemonShell` hosts the
shared `SettingsPanel` in a phone-sized layout. It reuses the desktop account,
provider, appearance, plugin catalog, and per-plugin pages. Native-only pages
are omitted in daemon mode.

`app/src/lib/hostPort.ts` is the host operation port. Only the daemon entry
installs a network adapter. With no alternative port installed, the existing
gateway sends exactly the same native Tauri calls as before.

The daemon's `management` directory separates the typed request port,
application use cases, and HTTP adapter. The HTTP adapter cannot directly
mutate the plugin registry. A bounded request queue hands operations to the
daemon's application loop.

- `crates/lilo-daemon` owns the HTTP server, mobile page, device configuration,
  session authorization, and calls into `lilo-core`.
- `lilo-core` remains free of Tauri and owns plugin loading, marketplace
  integrity checks, plugin settings, declarative UI validation, accounts, and
  command routing.
- The mobile page renders host-owned controls and the existing declarative
  plugin UI contract. Plugins never ship HTML or JavaScript for the management
  page.
- Provider login is capability-based. A provider appears as sign-in capable
  only when its adapter supplies a daemon-compatible mobile login flow. The
  desktop WebView phone-login bridge cannot be called from the daemon.

## Security boundaries

- The packaged launcher binds its management listener to localhost by default. Direct LAN
  deployments should use a trusted private network; reads of private state and
  all mutations require a paired mobile session.
- The optional HTTPS tunnel exposes the pairing page through an external
  HTTPS intermediary; its visibility and handling are described in
  [Privacy and data handling](../PRIVACY.md).
- Pairing is explicit, short-lived, and scoped to the device. Mutating requests
  require CSRF protection; request bodies, field sizes, and login attempts are
  bounded.
- Never put credentials, cookies, bearer tokens, Wi-Fi passwords, pairing
  secrets, or raw provider errors in logs, URLs, status snapshots, or plugin
  settings unless the plugin's declared setting is specifically a secret.
- Do not implement provider sign-in by posting credentials directly to vendor
  endpoints. Preserve real provider-page challenge and verification behavior.
- Mutations require a paired session and exact same-origin checks. A Wi-Fi join password is sent over the local network to this device's Wi-Fi manager; LILO does not upload or log it, and the operating system may save a profile. Plain HTTP does not encrypt this local-network transfer.

## Validation

- Exercise the API on Linux as an unprivileged daemon process with isolated
  data; verify pairing, rejection of unpaired mutations, bounded inputs,
  plugin catalog/install lifecycle, and persistence across restart.
- Exercise the mobile page on a real phone against representative Linux boards and computers.
- Verify that setup, plugin, provider, and Wi-Fi secrets do not appear in
  daemon logs, API responses, or URLs.
- Preserve Windows, macOS, and Linux workspace builds; daemon changes remain
  Linux-only and Tauri-free.

## Current implementation and limits

The opt-in management entry point reuses the desktop account, provider, plugin,
appearance and language pages. Device preferences persist in the daemon data
directory. Animations are disabled without a setting to enable them. Plugin
host compatibility filters both installed discovery and the marketplace.

The optional private login host supplies ChatGPT sign-in using the shared
Connect with phone form driver in the default Chromium/Xvfb/CDP browser host.
The same browser-host engine implementation runs the ChatGPT voice session, and
the browser is exclusive to one operation: login and voice cannot run together.
An opt-in WebKitGTK legacy login fallback does not provide voice. The renderer
uses the desktop Working/Ask/Error answer lifecycle. Normal email, password,
phone and verification-code questions use LILO's own HTML fields; provider
answer errors are shown instead of silently re-asking. Passwords are masked;
email and codes are visible. There is no generic mirrored-page typing control.
An explicit interactive provider challenge can still require a challenge image.
The renderer and virtual display run during login or active voice, and stop
when the operation ends. Form answers and challenge images
use independent AES-GCM envelopes between the phone and login host. Account
material is stored privately by the daemon and omitted from management replies.
The actual provider must accept the native login session; dependency and unit
checks alone do not validate its challenge.

The browser host runs as a regular container user, with all container
capabilities dropped. A verified namespace-enabled seccomp profile permits the
operations needed by the browser sandbox. The launcher never uses a privileged
container or disables seccomp or AppArmor.

See [Headless Linux](headless-linux.md) for packaged dependencies, Linux audio,
private pairing, tunnel operation, and standalone ChatGPT voice. Device microphone and speaker checks remain explicit actions separate
from starting a provider voice session.

The phone panel shows conversation status in Voice, Music and Settings. Use
**End conversation** to disconnect the provider; muting only disables microphone
input and leaves the session connected. Disable wake recognition in Device
preferences when you want to prevent another conversation from starting by voice.

Successful playback commands use the shared core's `endSession` result to close
the conversation, as on desktop. Wake recognition resumes after the audio handoff.
Say `lilo`, wait for the conversation to connect, then say `stop music`.

Standalone ChatGPT voice uses the optional Linux browser/audio host. Stories and study
plugins participate through tool calls, opening context and interaction questions
delivered through the active session. Persistent scheduling remains a shared core
capability and does not start a voice session. Other provider voice transports
and representative board resource measurements remain outstanding. First-boot Wi-Fi setup has only fake-unit coverage; physical
radio validation remains required. The desktop satellite path is separate from phone
management. See [Linux validation evidence](linux-validation.md) for recorded checks.
