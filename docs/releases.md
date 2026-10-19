# Desktop release builds

Install the development prerequisites described in the README, then run:

```sh
npm run typecheck
npm test
npm run build
cargo test --workspace
npm run tauri:build
```

`scripts/build.mjs` invokes `prepare-release.mjs` before Tauri. On macOS,
preparation rebuilds the wake helper for the selected architecture and signs
it ad hoc. `tauri.macos.conf.json` packages it at
`Resources/binaries/LiloWake.app`. No developer certificate identity is
embedded by this preparation step. Windows and Linux need no Swift helper.

Platform-specific installer commands:

| Host | Command | Installer |
| --- | --- | --- |
| Windows x64 | `npm run tauri:build -- --target x86_64-pc-windows-msvc --bundles nsis` | `.exe` |
| macOS Apple Silicon | `npm run tauri:build -- --target aarch64-apple-darwin --bundles app,dmg` | `.dmg`, signed `.app.tar.gz` |
| macOS Intel | `npm run tauri:build -- --target x86_64-apple-darwin --bundles app,dmg` | `.dmg`, signed `.app.tar.gz` |
| Linux x64 | `npm run tauri:build -- --target x86_64-unknown-linux-gnu --bundles deb,appimage` | `.deb`, `.AppImage` |

Build on the corresponding OS. Explicit targets put bundles in
`target/<target>/release/bundle/`; a host build without `--target` uses
`target/release/bundle/`. The desktop build is separate from the headless Linux device daemon.

## GitHub Actions

`.github/workflows/release-build.yml` checks `main` once daily at 02:00 UTC.
Pushes, pull requests and manual dispatch do not trigger it. GitHub can delay
scheduled starts; this is not an exact wall-clock timer. The planning job skips
native builds when the same main commit has a complete published release.
Incomplete publication is retried at the next scheduled run.

The frontend is checked and built once on Linux, then reused by all four native
jobs. JavaScript tests also run on Windows and Apple Silicon to retain OS-specific
coverage. Native workspace tests use the installer's release profile and compiler
path remapping, avoiding a separate debug dependency build. Native jobs depend on
the shared frontend, so a central failure prevents them from starting. Matrix
fail-fast cancels remaining native jobs after a failure. Publication requires all
four targets to succeed. No partial release is published. The current workflow marks published builds
as prereleases pending platform and device acceptance.

Installers are uploaded as temporary artifacts for one day; successfully published
packages remain at [GitHub Releases](https://github.com/swappcloud/lilo/releases/).
No provider account credentials are used.
Signed update artifacts require the repository secret
`TAURI_SIGNING_PRIVATE_KEY`; password-protected keys also require
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
The matching public key is embedded in `src-tauri/tauri.conf.json`; never
commit the private key. Keep a secure backup: replacing the key without a
transition build prevents existing installations from accepting updates.

For local builds, `scripts/build.mjs` uses the key at
`<home>/.config/lilo/signing/updater.key` when no signing key is supplied in
the environment. Generate a key with `npm exec tauri signer generate`; keep
it outside the checkout. GitHub Actions must have the corresponding secret
configured before the first signed release is built.

### Updates inside the app

Release metadata and installers must be publicly downloadable without a GitHub
account. Updater signatures verify packages; they do not grant repository access.
Never embed a repository access token in an installer.

The desktop app checks the public `swappcloud/lilo` GitHub releases after
startup and every six hours, including prereleases. It selects a newer
semantic version with an installer for this platform. It never downloads or
installs automatically: a native confirmation asks the user whether to update.
Settings → Updates also offers a manual check and an explicit install button.
Active voice sessions must end before installation. Packages must pass the
Tauri updater's signature verification before installation, then LILO restarts.

Windows uses the NSIS installer, macOS a signed `.app.tar.gz`, and Linux
AppImage updates itself. Linux `.deb` installations receive an update notice
and a link to the release to download the package. Headless daemon upgrades
use the [Linux installer](headless-linux.md#install-with-one-command).
An older LILO build without this updater needs one manual installation of
the first new version; it cannot retrofit the updater into itself.

The updater sends ordinary requests to GitHub for release metadata and
artifacts; GitHub necessarily sees the connection's IP address. It sends no
provider tokens, account identifiers, chats, or settings. Local updater logs
contain stages, rounded progress changes, and confirmation outcomes, not raw
errors or provider data. The app identifier and storage locations stay the
same so installers preserve accounts and settings. Keep the previous installer
available for manual recovery; this implementation does not promise automatic
rollback or a zero-risk update.

`scripts/update-artifacts.mjs` validates and assembles `latest.json` and
signature assets. A platform retry merges the existing manifest so another
platform's previously published update does not disappear.

The application, Windows installer and uninstaller use the LILO brand icon.
The macOS DMG uses it for the mounted volume and the application inside it;
Finder may still display its standard disk-image icon on the unopened `.dmg`
file. Linux launchers and AppImage use the application icon; `.deb` file icons
are selected by the user's file manager. Icons are generated from
`src-tauri/app-icon.svg`, using the paths in
`app/src/shared/brand/logoPaths.ts`.

Updater signatures are independent of OS distribution signing. They do not
remove Windows SmartScreen or macOS Gatekeeper warnings. Windows installers
still need trusted Authenticode signing and reputation; macOS needs Developer
ID signing and Apple notarization for recognized distribution.

On Windows the app manifest (Common Controls v6) is embedded in every linked
target, test harnesses included; without it `cargo test` aborts with
`STATUS_ENTRYPOINT_NOT_FOUND` before running a test. Tests reach local servers
through `127.0.0.1`: Windows refuses a connection to `0.0.0.0`.

The scheduled release uses GitHub-hosted runners. Review current
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
before changing runner types or enabling paid usage.

## Distribution checks

Windows installers are unsigned and macOS packages are ad-hoc signed, without
Apple notarization. OS download warnings may require explicit user approval.
Trusted public distribution signing is separate from generating an executable;
the build does not assume paid certificates or an Apple Developer membership.

Install and launch the generated package on its target OS. Verify sign-in,
phone sign-in, microphone, playback, wake word where supported, bundled plugins
and automatic media provisioning. On macOS, confirm `helper READY` in the app
and that a spoken wake phrase starts a session. A successful compile alone
does not validate TCC permissions or installed-app audio behavior.

Before publishing the repository or binaries, review tracked files, pending
changes and every reachable Git commit for credentials and personal identifiers.
Include author/committer email addresses in that review. Investigate scanner
findings before classifying them; tests can contain deliberately invalid tokens.
Use redacted scanner output and keep reports under `.tmp/`. History rewriting
requires explicit owner approval before replacing published commits. Only upload
installer outputs; never package account data, browser profiles or scratch files.

## macOS permissions when testing a release

Install LILO from the DMG into Applications and close the development app before
testing. Development permission does not prove that the packaged app has access.
Allow Microphone and Speech Recognition for LILO / LILO Wake in System Settings
→ Privacy & Security. A wake helper response `ERR no-mic-permission` means macOS
denied microphone access; rebuilding does not grant that permission.

Builds restore the npm download cache and Rust dependency artifacts with separate
Rust cache keys for each runner and target. Rust's compiler and dependency hashes
invalidate incompatible entries automatically; application crates are rebuilt.
Frontend checks run before native tooling and compilation, so a failing test
stops that job early. The first build fills the caches; later builds can reuse
them. Installer artifacts still expire after one day; published release assets
remain available.

### Versions

A release is immutable: one semantic version and one main commit. All four
version manifests must agree. The planner honors a newer version committed to
main; otherwise it selects the next patch after the highest existing release.
The selected version and release notes are applied only inside each disposable
CI checkout, never committed or pushed by the workflow. Lockfiles are not edited
by the version preparation script. This lets changed main receive a new release
even when its source version has not been manually bumped.

You can still choose a minor or major version locally with
`npm run version:bump -- minor` or `major`. A partial or draft release from the
same commit is retried under its original version on the next scheduled run.
Resources are prepared once per native target. The installer merges
`scripts/tauri-prebuilt.conf.json` and sets `LILO_PREPARED` to avoid rebuilding
Swift resources or the shared frontend. macOS uses an explicit ad-hoc identity
for both app and helper. The release environment discards Apple certificate and
notarization credentials and never searches the local keychain. Ad-hoc signing
still requires users to approve downloaded apps in macOS Privacy & Security.
Updater signatures remain required and independent of Apple signing.

## Conversation and Windows diagnostics

Settings → Voice → Conversation closes quiet voice sessions after 30 seconds by default. Set the timeout to 0 to disable it, or choose 1–3600 seconds. Speech, captions and interaction restart the deadline; closing releases the voice connection and preserves history.

On Windows, phone login keeps the provider window visible while the phone drives its form. The initial blank navigation is not probed. Validate ChatGPT and Claude phone login in the installed app; successful unit tests do not prove an external sign-in page still works.

Download logs from the LILO menu or Settings → Application → Diagnostics. The native save dialog writes a bounded report containing approved event labels, loading state, counts and selected error codes, with app version and platform. Raw messages, credentials, conversations, URLs and file paths are omitted, and LILO does not upload the report.

### Windows uninstall validation

The standard Tauri NSIS uninstaller removes desktop shortcuts that target the installed LILO executable. LILO then sends `SHCNE_UPDATEDIR` through `SHChangeNotify` for the current desktop, using Unicode paths, so Explorer can refresh its view. Updater uninstalls preserve their existing shortcut behavior.

On Windows, install with the desktop shortcut enabled, uninstall through Settings, and check that the shortcut disappears. If it remains, press F5. A shortcut that disappears after F5 indicates a stale desktop view; one that still exists requires checking its Properties → Target and whether it came from a different installation. Verify redirected/OneDrive desktop paths as well.
