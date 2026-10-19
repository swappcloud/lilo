#!/bin/sh
# A small-board-shaped Linux box on the Mac, for running what the Pi will run.
#
# Same userland as the board — 32-bit ARM, Debian 12, which is what Raspberry
# Pi OS Bookworm is — and the same resource envelope it reports: 921 MB of RAM,
# 199 MB of swap, four cores. Everything heavy runs here instead of on the Pi
# (a DNS appliance that must stay responsive), and the envelope keeps the Mac
# usable while it runs.
#
# What this cannot simulate, and why the real board still matters:
#   * speed — QEMU emulation is far slower than the board's 900 MHz A7, so no
#     timing, CPU or latency number measured here means anything;
#   * audio — there is no sound device, so wake word and STT can neither run
#     nor be measured: that is the M5 gate, and it happens on hardware;
#   * the SD card — I/O is the Mac's disk through a VM share, not ~15 MB/s of
#     card, and Docker has no throttle for a container's writable layer;
#   * `/proc/meminfo` — the cgroup limit is real (the box is OOM-killed at the
#     Pi's 921 MB), but meminfo reports the whole Docker VM.
# Use it for 32-bit assumptions, armhf portability and OOM/leaks inside the
# Pi's memory — never for measuring the Pi.
#
# Usage: scripts/pi-sim.sh test [cargo test args...]   lilo-core test suite
#        scripts/pi-sim.sh build [cargo args...]       build a binary
#        scripts/pi-sim.sh daemon [args...]            run the built daemon
#        scripts/pi-sim.sh shell                       interactive shell
#        scripts/pi-sim.sh run <command...>            one command in the box
#
# The box has a persistent data volume at /data (settings, accounts, plugins),
# and the repository at /w.
#
# PI_CPUS (default 2; the board has 4) raises the CPU budget. PI_MEM/PI_SWAP
# override the envelope in MB. PI_SIM_TIMEOUT bounds the heavy modes, in
# seconds, and the box is killed when it runs out — it can never hang the Mac.
set -eu

cd "$(dirname "$0")/.."

MODE="${1:-test}"
[ $# -gt 0 ] && shift || true

PI_CPUS="${PI_CPUS:-2}"
PI_MEM="${PI_MEM:-921}"
PI_SWAP="${PI_SWAP:-199}"
TIMEOUT="${PI_SIM_TIMEOUT:-3600}"
PLATFORM="linux/arm/v7"
CARGO_VOL="lilo-pi-cargo"
TARGET_VOL="lilo-pi-target"
DATA_VOL="lilo-pi-data"
NAME="lilo-pi-$MODE"
LOG=".tmp/pi-sim-$MODE.log"

command -v docker >/dev/null 2>&1 || { echo "docker not found (install Docker Desktop)"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running"; exit 1; }
mkdir -p .tmp

# Envelope. A cpuset (when the VM has the cores) makes `nproc` and cargo's
# parallelism see the Pi's core count; the quota bounds what it costs the Mac.
LIMITS="--cpus=$PI_CPUS --memory=${PI_MEM}m --memory-swap=$((PI_MEM + PI_SWAP))m"
VM_CPUS="$(docker info --format '{{.NCPU}}' 2>/dev/null || echo 0)"
case "$VM_CPUS" in
  ''|*[!0-9]*) VM_CPUS=0 ;;
esac
if [ "$VM_CPUS" -ge "$PI_CPUS" ]; then
  LIMITS="$LIMITS --cpuset-cpus=0-$((PI_CPUS - 1))"
fi

# Build caches and the box's data live in Docker volumes: inside the VM, never
# on the Mac's filesystem, so no editor indexes them and no virus scanner walks
# them.
for vol in "$CARGO_VOL" "$TARGET_VOL" "$DATA_VOL"; do
  docker volume create "$vol" >/dev/null
done
docker run --rm -u 0 -v "$CARGO_VOL":/c -v "$TARGET_VOL":/t -v "$DATA_VOL":/d \
  rust:1-bookworm chown "$(id -u):$(id -g)" /c /t /d >/dev/null 2>&1 || true

# The first free TCP port at or after $1, so a test never lands on one the
# machine already uses (a browser, another container, a dev server).
free_port() {
  candidate="$1"
  while [ "$candidate" -lt 8600 ]; do
    if ! nc -z 127.0.0.1 "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
    candidate=$((candidate + 1))
  done
  echo "$1"
}

box_run() { # box_run <tty|typing|plain> <mapping|none> <image> <command...>
  interaction="$1"
  mapping="$2"
  image="$3"
  shift 3
  flags=""
  case "$interaction" in
    tty) flags="-it" ;;
    typing) flags="-i" ;;
  esac
  # The setup page listens on 80 inside the box (a captive portal has to);
  # publishing it on a free host port is what lets a browser here open it. The
  # capability is what a systemd unit would grant to bind a low port without
  # running the daemon as root.
  if [ "$mapping" != "none" ]; then
    flags="$flags -p $mapping --cap-add=NET_BIND_SERVICE"
  fi
  # shellcheck disable=SC2086  # $flags and $LIMITS are lists on purpose
  exec docker run --rm $flags --hostname lilo-pi --platform "$PLATFORM" $LIMITS \
    -u "$(id -u):$(id -g)" -e HOME=/tmp -e LILO_PI_SIM=1 \
    -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target \
    -v "$CARGO_VOL":/cache/cargo -v "$TARGET_VOL":/cache/target \
    -v "$DATA_VOL":/data -v "$PWD":/w -w /w \
    "$image" "$@"
}

box_detached() { # box_detached <image> <command...>
  image="$1"
  shift
  # shellcheck disable=SC2086
  docker run -d --name "$NAME" --hostname lilo-pi --platform "$PLATFORM" $LIMITS \
    -u "$(id -u):$(id -g)" -e HOME=/tmp -e LILO_PI_SIM=1 \
    -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target \
    -v "$CARGO_VOL":/cache/cargo -v "$TARGET_VOL":/cache/target \
    -v "$DATA_VOL":/data -v "$PWD":/w -w /w \
    "$image" "$@" >/dev/null
}

heavy() { # heavy <image> <command...>: detached, logged, killed on the deadline
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  box_detached "$@"

  deadline=$(( $(date +%s) + TIMEOUT ))
  ticks=0
  while [ "$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || echo gone)" = "running" ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "==> deadline reached; killing the container" >&2
      docker kill "$NAME" >/dev/null 2>&1 || true
      docker logs "$NAME" > "$LOG" 2>&1 || true
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      echo "full log in $LOG" >&2
      exit 124
    fi
    ticks=$((ticks + 1))
    if [ "$ticks" -ge 6 ]; then
      ticks=0
      echo "    [$(docker logs "$NAME" 2>/dev/null | grep -c Compiling)] $(docker logs --tail 1 "$NAME" 2>/dev/null)"
    fi
    sleep 5
  done

  docker logs "$NAME" > "$LOG" 2>&1
  EXIT=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  grep -E '^(test result|running [0-9]+ tests|error)' "$LOG" | tail -6
  [ "$EXIT" -eq 0 ] && echo "==> ok — log in $LOG" || echo "==> FAILED (exit $EXIT) — log in $LOG"
  exit "$EXIT"
}

case "$MODE" in
  test)
    echo "==> Pi simulator (armv7, ${PI_CPUS} cores, ${PI_MEM}MB+${PI_SWAP}MB), ${TIMEOUT}s deadline"
    # QEMU answers the spawn of a missing binary with success, so this one test
    # cannot say anything true while emulated.
    heavy rust:1-bookworm cargo test --jobs 1 -p lilo-core -p lilo-daemon "$@" -- \
      --skip a_missing_binary_reports_instead_of_panicking
    ;;
  build)
    echo "==> Pi simulator (armv7), build, ${TIMEOUT}s deadline"
    heavy rust:1-bookworm cargo build "$@"
    ;;
  daemon)
    PORT="$(free_port 8080)"
    echo "==> setup page will be at http://localhost:$PORT/ (inside the box: port 80)"
    box_run typing "$PORT:80" debian:bookworm-slim /cache/target/debug/lilo-daemon \
      --data-dir /data "$@"
    ;;
  shell)
    box_run tty none debian:bookworm-slim bash
    ;;
  run)
    [ $# -gt 0 ] || { echo "usage: $0 run <command...>" >&2; exit 2; }
    box_run plain none debian:bookworm-slim "$@"
    ;;
  *)
    echo "usage: $0 [test|build|daemon|shell|run <command>] [args...]" >&2
    exit 2
    ;;
esac
