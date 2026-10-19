#!/bin/sh
# Install and start the Linux device runtime without running LILO as root.
set -eu
fail() { printf '%s\n' "$*" >&2; exit 1; }
install_deps=0
for argument in "$@"; do
  case "$argument" in
    --install-system-deps) install_deps=1 ;;
    --lan) export LILO_MANAGEMENT_BIND=0.0.0.0 ;;
    --help) printf '%s\n' 'Usage: sh scripts/install-headless.sh [--install-system-deps] [--lan]' 'System package changes require sudo; runtime always uses your regular user.' 'LAN HTTP is supported on a trusted network; this installer never opens a tunnel.'; exit 0 ;;
    *) fail "Unknown option: $argument" ;;
  esac
done
[ "$(uname -s)" = Linux ] || fail 'This installer requires Linux.'
[ "$(id -u)" != 0 ] || fail 'Run this installer as your regular user, not with sudo.'
case "$(uname -m)" in x86_64|aarch64) ;; *) fail 'Use a 64-bit x86_64 or aarch64 Linux installation.' ;; esac
[ -r /etc/os-release ] || fail 'Cannot identify the Linux distribution.'
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in *debian*|*ubuntu*|*raspbian*) ;; *) fail 'Automatic installation supports Debian, Ubuntu and Raspberry Pi OS only.' ;; esac
LILO_INSTALL_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export LILO_INSTALL_ROOT
cd "$LILO_INSTALL_ROOT"
[ -f Cargo.toml ] && [ -f scripts/daemon-runtime.mjs ] || fail 'Use the complete LILO source package, not an isolated installer file.'
if [ "$install_deps" = 1 ]; then
  command -v sudo >/dev/null 2>&1 || fail 'sudo is required to install system dependencies.'
  printf '%s\n' 'Installing Docker, the launcher and Linux audio dependencies with sudo.'
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends docker.io nodejs pulseaudio-utils ca-certificates dbus-user-session
  # Keep an existing PipeWire-Pulse server instead of replacing its backend.
  if [ -z "${PULSE_SERVER:-}" ] && [ ! -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/pulse/native" ] && ! command -v pipewire-pulse >/dev/null 2>&1; then
    sudo apt-get install -y --no-install-recommends pulseaudio
  fi
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable --now docker
    if command -v loginctl >/dev/null 2>&1; then sudo loginctl enable-linger "$(id -un)"; fi
    if systemctl --user list-unit-files pulseaudio.socket --no-legend 2>/dev/null | grep -q '^pulseaudio.socket'; then
      systemctl --user enable --now pulseaudio.socket
    fi
  fi
  if ! docker info >/dev/null 2>&1; then
    printf '%s\n' 'Docker group access grants control of this host. Continuing in a new group session.'
    sudo usermod -aG docker "$(id -un)"
    exec sg docker -c 'exec sh "$LILO_INSTALL_ROOT/scripts/install-headless.sh"'
  fi
fi
command -v docker >/dev/null 2>&1 || fail 'Docker is missing. Rerun with --install-system-deps or provision Docker first.'
command -v node >/dev/null 2>&1 || fail 'Node.js is missing. Rerun with --install-system-deps or provision Node.js first.'
node -e 'if (Number(process.versions.node.split(".")[0]) < 18) process.exit(1)' || fail 'The launcher requires Node.js 18 or newer.'
docker info >/dev/null 2>&1 || fail 'Your user needs access to a running Linux Docker engine.'
if [ -z "${PULSE_SERVER:-}" ]; then
  pulse_socket=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/pulse/native
  if [ ! -S "$pulse_socket" ] && command -v pulseaudio >/dev/null 2>&1; then
    pulseaudio --start --exit-idle-time=-1
  fi
  [ ! -S "$pulse_socket" ] || export PULSE_SERVER="unix:$pulse_socket"
fi
[ -n "${PULSE_SERVER:-}" ] || fail 'No Pulse-compatible audio server found. Connect an audio device and start PulseAudio or PipeWire-Pulse for this user.'
case "$PULSE_SERVER" in unix:/*) ;; *) fail 'Use a local Unix Pulse-compatible socket for device audio.' ;; esac
printf '%s\n' 'Building device assets with Node.js 22, then packaging all runtime dependencies.'
mkdir -p .tmp
docker run --rm --user "$(id -u):$(id -g)" --mount "type=bind,src=$LILO_INSTALL_ROOT,dst=/source,readonly" --mount "type=bind,src=$LILO_INSTALL_ROOT/.tmp,dst=/output" -e npm_config_cache=/output/npm-install-cache node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 sh -c '
  set -eu
  build_root=$(mktemp -d)
  tar -C /source --exclude=node_modules --exclude=.git --exclude=target --exclude=dist --exclude=.tmp --exclude=".env*" -cf - . | tar -C "$build_root" -xf -
  cd "$build_root"
  npm ci --ignore-scripts --no-audit --no-fund
  npm run build:daemon
  npm run build:daemon-voice
  for asset in daemon-web daemon-voice; do
    mkdir -p "/output/$asset"
    cp -R ".tmp/$asset/." "/output/$asset/"
  done
'
LILO_WEB_ASSETS_BUILT=1 node scripts/daemon-runtime.mjs build
node scripts/daemon-runtime.mjs start
printf '%s\n' 'Saved accounts and device data are preserved across reinstallations.' 'Pair through the device IP on your trusted LAN. No tunnel has been started.'
