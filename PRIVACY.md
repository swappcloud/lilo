# Privacy

LILO keeps its settings, account sessions, plugin data and local conversation history on your device. It does not automatically upload conversations or diagnostics to the project maintainers.

## Provider connections

Microphone audio, prompts, captions and context you choose to share are sent to the active provider using your account. The provider handles that data according to its own settings and privacy policy. Provider web pages can make their own network requests.

Sign-in uses the provider's page. Browser cookies and sessions remain in local provider profiles; account tokens may also be saved in LILO's local account storage. These files are not guaranteed to be encrypted by LILO. Protect your device and backups.

If you configure an external gateway, it can receive connection data and authentication headers. Choose an endpoint you trust.

## Local data and controls

The desktop stores data in its application-data directory, provider browser profiles and local browser storage. The daemon uses its configured data directory. Plugins can keep their own local records.

You can stop voice, mute the microphone, sign out, delete local histories and plugin items, and disable or uninstall plugins. Removing a local history entry does not delete the provider's copy. Uninstalling the application can leave local data and browser profiles behind.

## Plugins and network requests

Plugin permissions can allow local commands, HTTP requests, screen capture and conversation access. Provider plugins can interact with their own signed-in browser profile. Install plugins you trust and review their permissions. Process plugins run as separate programs and are not an operating-system sandbox.

Weather and location requests contact the selected location/weather services. Media searches and playback contact media sources. Marketplace, update checks and tool downloads contact GitHub or upstream download servers. Those servers receive ordinary connection metadata, including your IP address.

## Phone management and audio

Phone management uses a private pairing link. Keep it private and use a trusted network. Daemon login form fields and challenge images are encrypted between the phone and login host. If you use a tunnel, its operator can see management traffic outside that encrypted payload.

Voice uses the selected microphone and speakers. Wake listening processes microphone input while enabled. Explicit device microphone checks sample audio briefly and return a level measurement; they do not save that sample or send a recording to the phone.

## Diagnostics

Operational logs are local. Diagnostic export is user initiated and filters credentials, conversation text, account details and personal paths. LILO does not automatically upload the report. Review files before sharing them, and keep credentials and private recordings out of public issues.
