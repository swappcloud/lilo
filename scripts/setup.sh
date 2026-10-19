#!/bin/sh
# One-command setup for macOS/Linux. Windows uses setup.cmd.
# Installs Node 22 when missing (Homebrew only), then scripts/setup.mjs.
set -eu
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null; then
  if command -v brew >/dev/null; then
    echo "==> installing Node.js 22 with Homebrew"
    brew install node@22
    PATH="$(brew --prefix node@22)/bin:$PATH"
  else
    echo "Node.js 22 is required: https://nodejs.org" >&2
    exit 1
  fi
fi

node scripts/setup.mjs
