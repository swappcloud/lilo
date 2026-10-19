#!/bin/sh
# POSIX entry point; Windows uses `node scripts/build-marketplace.mjs`.
set -eu
exec node "$(dirname "$0")/build-marketplace.mjs" "$@"
