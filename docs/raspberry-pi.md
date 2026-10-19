# Linux board validation

This page records engineering checks for Linux boards. Raspberry Pi is one
example; the generic installation also targets compatible Orange Pi boards and
Linux computers. For general Linux daemon setup,
phone management, and standalone ChatGPT voice, see
[Headless Linux](headless-linux.md). Raspberry Pi support depends on the
specific board's architecture, audio hardware, radio and installed dependencies;
these checks do not establish support for every Linux device.

## Developer checks on a Linux device

Use the repository's existing Rust toolchain setup, then run from its root:

```sh
cargo test -p lilo-core -p lilo-daemon
cargo build --release -p lilo-daemon
```

Use a fresh task directory for a credential-free check:

```sh
mkdir -p .tmp/device-check
./target/release/lilo-daemon --data-dir .tmp/device-check --check
./target/release/lilo-daemon --data-dir .tmp/device-check --once "lilo stop the music"
```

These checks verify command startup and routing, not microphone, wake or
provider voice on the board. Installed plugins live under the selected data
directory's `plugins/`. Check declared `platforms` and executable requirements before
copying a plugin. Desktop-only tools must report unavailability on a headless
board instead of blocking the daemon. Media binaries are provisioned by the
application where the pinned platform/digest table supports the board.

For a paired audio satellite, use `lilo-daemon --help` for `--satellite`,
`--satellite-key`, `--phrase` and `--answer`. A running desktop owns the provider
session. Pair only on a trusted private network, and keep the key private.

## Host-side Linux checks

On a development host with Docker available:

```sh
npm run test:linux
npm run test:pi
```

The first exercises Linux ARM64 core/daemon. The second uses the existing
32-bit ARM small-board container. QEMU timing and the host disk do not measure
real Pi latency, SD-card throughput or audio performance. A real board remains
necessary for those checks. On Windows use the Docker-supported POSIX shell
for the supplied `.sh` scripts; direct `cargo` commands above do not require
that shell. Never run the desktop Tauri package as a replacement for the
headless daemon.

The 32-bit test simulator builds with one Cargo job to fit the small-board
memory envelope. Its runner excludes the existing missing-binary spawn test
because QEMU reports that operation differently; this exclusion does not apply
to native board tests. Emulation does not validate the real microphone path.

## Recorded validation results

- Linux ARM64 container: 422 core tests and 40 daemon tests passed; 6 core tests ignored.
- ARMv7 container (921 MB RAM, 199 MB swap): 421 core tests and 40 daemon tests passed; 6 core tests ignored and the QEMU-incompatible missing-binary test filtered out.
- Local daemon `--check` starts successfully with a fresh account-free data directory.

These checks validate command/plugin startup, not physical-board voice, audio,
Wi-Fi or peak resource use. See [Linux validation evidence](linux-validation.md)
for container voice/audio observations and [Linux setup](headless-linux.md) for
current installation requirements and feature limits.

An additional local daemon acceptance run loaded the Qwen provider, greeting
and notes plugins together (3 loaded, 0 failed), then executed the greeting
command successfully. This proves coexistence and local routing, not Qwen voice
access on the headless host.
