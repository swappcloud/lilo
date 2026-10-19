#!/bin/sh
# Run lilo-core's test suite on Linux, natively, in a container on this machine.
#
# The desktop app cannot be tested here (Tauri needs webkit2gtk/GTK), and the
# headless Linux device is not a build machine. This is the fast Linux check: native
# arm64 — the architecture of a 64-bit Pi and of CI. For the board's own 32-bit
# userland and its memory envelope, use scripts/pi-sim.sh.
#
# Build caches live in Docker volumes — inside the VM, never on the Mac's
# filesystem, so no editor indexes them and no virus scanner walks them — and
# the container is capped, so a run cannot starve the machine it borrows.
#
# Usage: scripts/test-linux.sh [cargo test args...]
#
# LILO_TEST_CPUS (default 4) is the CPU budget; LILO_TEST_TIMEOUT (default
# 900s) kills the container when it runs out, so it can never hang the Mac.
set -eu

cd "$(dirname "$0")/.."

CPUS="${LILO_TEST_CPUS:-4}"
TIMEOUT="${LILO_TEST_TIMEOUT:-900}"
NAME="lilo-test-arm64"
LOG=".tmp/test-linux-arm64.log"

command -v docker >/dev/null 2>&1 || { echo "docker not found (install Docker Desktop)"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running"; exit 1; }
mkdir -p .tmp

# Caches on named volumes; they are created root-owned, so they are handed to
# the developer once, and every run then writes as the host user.
for vol in lilo-cargo lilo-target-arm64; do
  docker volume create "$vol" >/dev/null
done
docker run --rm -u 0 -v lilo-cargo:/c -v lilo-target-arm64:/t rust:1-bookworm \
  chown "$(id -u):$(id -g)" /c /t >/dev/null 2>&1 || true

docker rm -f "$NAME" >/dev/null 2>&1 || true
echo "==> Linux arm64, up to ${CPUS} CPUs, ${TIMEOUT}s deadline"

docker run -d --name "$NAME" --platform linux/arm64 --cpus="$CPUS" \
  -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target \
  -v lilo-cargo:/cache/cargo -v lilo-target-arm64:/cache/target \
  -v "$PWD":/w -w /w \
  rust:1-bookworm cargo test -p lilo-core -p lilo-daemon "$@" >/dev/null

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
if [ "$EXIT" -eq 0 ]; then
  echo "==> ok (arm64) — log in $LOG"
else
  echo "==> FAILED (exit $EXIT) — log in $LOG"
fi
exit "$EXIT"
