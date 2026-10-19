# LILO daemon on Linux

Run LILO without a desktop window on compatible Linux computers and boards.
Manage settings, accounts, music and compatible plugins from your phone. An
optional browser/audio host provides standalone ChatGPT voice with your own
account. Windows, macOS and Linux desktop installations are described in the
[README](../README.md); no OS or board is the primary target.

## Requirements

The installer supports **64-bit Debian/Ubuntu-based Linux**, including 64-bit
Raspberry Pi OS, on **ARM64 or x86-64**. Other distributions can run the daemon,
but this installer does not provision their dependencies.

For voice, provide a microphone, audio output and a working PulseAudio endpoint
(or PipeWire's PulseAudio compatibility service). The host needs internet access
for installation, provider sign-in, voice and remote media. Connect it through
Ethernet or the OS Wi-Fi setup before installing. The phone must be able to
reach its management endpoint.

**A minimum RAM requirement has not been established.** Recorded container
working sets were about 23–25 MiB combined at initial idle, before browser
startup. One active ChatGPT voice sample used about 4.4 MiB for the Rust daemon
and 281 MiB for the browser host. These figures exclude host OS memory and do
not measure peaks during installation, login, voice or media playback. They do
not establish a minimum hardware requirement.
See [measurement evidence](linux-validation.md) for environments and methods.

## Install with one command

Run as your regular user on the Linux device, with `curl` and `tar` available:

```sh
curl -fsSL https://raw.githubusercontent.com/swappcloud/lilo/main/scripts/install-daemon.sh | sh -s -- --install-system-deps --lan
```

The public command is available once this script is published and a published
GitHub release contains the daemon installer. It downloads that release's source
archive automatically, including prereleases produced by the current release
workflow; no Git installation, clone, local Node or Rust setup is
required beforehand. It builds the mobile interface and runtime containers on
the device. This is not a prebuilt daemon binary download: first installation
needs compilation time, disk space and more memory than normal operation.

`--install-system-deps` uses `sudo` to provision Docker, the Node launcher and
Linux audio packages. It enables Docker startup and supported user audio services
on systemd hosts, retains existing PipeWire audio, and grants your user Docker
access if needed. Docker group membership grants control of the host. The daemon
and browser run as regular container users, without privileged containers.

`--lan` exposes management on port 8788 to the local network. Omit it to bind
only to localhost. If Docker, Node 18+ and audio are already available, omit
`--install-system-deps`. Node 22 for frontend compilation runs inside a container.

The default installation directory is `$XDG_DATA_HOME/lilo/daemon`, or
`$HOME/.local/share/lilo/daemon` when `XDG_DATA_HOME` is unset. Downloaded release
sources live in `releases/`; account, pairing and device data live in `data/`.
`current` points to the last successfully installed source version. Repeating
the command installs the latest published release and preserves that data.
Use `LILO_INSTALL_DIR` for a different absolute installation path or
`LILO_INSTALL_REF` to select a release tag or commit. To inspect the script before
running it, download it to a file and invoke `sh install-daemon.sh --help`.

For an existing source checkout, the underlying installer remains available:

```sh
sh scripts/install-headless.sh --install-system-deps --lan
```

## Phone access and service commands

Open the management page through `http://DEVICE_IP:8788` on a trusted LAN.
Provider sign-in fields and challenge images retain AES-GCM encryption even
when the browser does not expose SubtleCrypto on an HTTP origin. Management
traffic and Wi-Fi settings still rely on the trusted network; HTTP is not TLS.
A tunnel is optional and is not required for local use. Pairing links and account files are private;
keep them out of issues and screenshots. See [phone management](daemon-phone-management.md)
for pairing, authorization and sign-in behavior.

From the installed source directory:

```sh
cd "${LILO_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/lilo/daemon}/current"
node scripts/daemon-runtime.mjs check
node scripts/daemon-runtime.mjs stop
node scripts/daemon-runtime.mjs start
node scripts/daemon-runtime.mjs pair http://DEVICE_IP:8788
```

Stopping preserves data. Containers restart automatically with Docker unless
explicitly stopped. When starting manually, use the same audio endpoint and LAN
binding as installation. For example, on a host with a standard user Pulse socket:

```sh
PULSE_SERVER="unix:${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/pulse/native" LILO_MANAGEMENT_BIND=0.0.0.0 node scripts/daemon-runtime.mjs start
```

If your audio socket is elsewhere, supply its actual path. Microphone and speaker
checks are explicit actions in the phone's Device settings.

### WSL testing over HTTP

Run the daemon on `0.0.0.0:8788` and open its private pairing link using the
WSL IPv4 address. From Windows, `wsl.exe -d Debian hostname -I` lists that
address. The page is available at `http://WSL_IP:8788`; no tunnel is needed.
The pairing fragment is still required to manage the device.

For a phone on the same Wi-Fi, WSL NAT requires forwarding through the
Windows LAN address. Run the repository helper in an administrator
PowerShell, replacing the address with the Windows Wi-Fi IPv4 address:

```powershell
.\scripts\wsl-phone-access.ps1 -Distro Debian -ListenAddress WINDOWS_LAN_IP -Port 8788
```

Open `http://WINDOWS_LAN_IP:8788` with the same pairing fragment. The helper
restricts the firewall rule to the selected interface and local subnet;
pass `-Remove` with the same arguments to remove the forwarding and rule.
The distro name and IP addresses depend on the machine.

WSLg provides microphone access through its PulseAudio socket. A wake
listener needs a working capture source; testing HTTP alone does not verify
the microphone or recognition. See [Linux validation](linux-validation.md).

## Available features and limits

Standalone daemon voice currently supports ChatGPT. The Chromium/Xvfb host
starts its browser for sign-in or voice and closes it afterward. Provider
verification, account plans and quotas still apply. Local wake listening starts the configured provider with a healthy account
while idle and enabled. It pauses before voice and during phone sign-in
activity. PocketSphinx recognizes the configured keyword locally; no local
LLM or TTS is involved. See the [wake architecture](architecture.md#wake-word)
for dictionary constraints and device acceptance. A paired desktop satellite is a separate option.

Local media uses the shared media service, pinned yt-dlp/Deno where supported,
and Linux mpv. The packaged runtime includes mpv; playback depends on a working
audio endpoint and remote resolver. Compatible QuickJS plugins use shared command,
tool, interaction and scheduling contracts. Desktop-only plugins are filtered out.

The phone can inspect and manage Wi-Fi after the device joins a network through
its supported network manager. Automatic first-boot access-point provisioning
has no physical-radio validation. Other provider voice adapters and representative
board resource behavior remain unverified.

## Measure a device

From the installed source directory:

```sh
node scripts/daemon-resources.mjs 5
```

Measure initial idle, login, voice/music and idle after voice separately. This
reports container CPU, memory working set and task counts; it excludes host OS
usage and does not inspect accounts or conversations. Container limits are
ceilings, not minimum hardware requirements. Validate audio, media and Wi-Fi on
the chosen hardware. See [Linux validation evidence](linux-validation.md) and
[board validation](raspberry-pi.md) for recorded results and developer checks.
