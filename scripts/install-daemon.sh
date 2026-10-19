#!/bin/sh
# Download the public release source and delegate Linux runtime provisioning.
set -eu

main() {
  install_deps=0
  lan=0
  for argument in "$@"; do
    case "$argument" in
      --install-system-deps) install_deps=1 ;;
      --lan) lan=1 ;;
      --help)
        printf '%s\n' 'Usage: install-daemon.sh [--install-system-deps] [--lan]' \
          'Downloads the latest public release; no Git checkout is needed.' \
          'LILO_INSTALL_REF selects a release tag or commit instead.' \
          'LILO_INSTALL_DIR overrides the persistent installation directory.'
        return ;;
      *) printf 'Unknown option: %s\n' "$argument" >&2; return 1 ;;
    esac
  done
  [ "$(uname -s)" = Linux ] || { printf '%s\n' 'The daemon installer requires Linux.' >&2; return 1; }
  [ "$(id -u)" != 0 ] || { printf '%s\n' 'Run as your regular user, not with sudo.' >&2; return 1; }
  case "$(uname -m)" in x86_64|aarch64) ;; *) printf '%s\n' 'Use 64-bit x86_64 or ARM64 Linux.' >&2; return 1 ;; esac
  for binary in curl tar mktemp sed; do
    command -v "$binary" >/dev/null 2>&1 || { printf 'Required command missing: %s\n' "$binary" >&2; return 1; }
  done
  install_dir=${LILO_INSTALL_DIR:-${XDG_DATA_HOME:-${HOME:?HOME must be set}/.local/share}/lilo/daemon}
  case "$install_dir" in /*) ;; *) printf '%s\n' 'LILO_INSTALL_DIR must be an absolute path.' >&2; return 1 ;; esac
  ref=${LILO_INSTALL_REF:-}
  if [ -z "$ref" ]; then
    # Public release listings include prereleases; /releases/latest excludes them.
    metadata=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 15 --max-time 60 \
      'https://api.github.com/repos/swappcloud/lilo/releases?per_page=1')
    ref=$(printf '%s\n' "$metadata" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')
    [ -n "$ref" ] || { printf '%s\n' 'No public release is available. Retry after publication.' >&2; return 1; }
  fi
  case "$ref" in ''|*[!a-zA-Z0-9._-]*) printf '%s\n' 'Use a release tag or commit containing letters, digits, dots, underscores or hyphens.' >&2; return 1 ;; esac
  case "$ref" in [a-zA-Z0-9]*) ;; *) printf '%s\n' 'A release reference must start with a letter or digit.' >&2; return 1 ;; esac
  mkdir -p "$install_dir"
  staging=$(mktemp -d "$install_dir/.install-XXXXXXXX")
  trap 'rm -rf "$staging"' 0
  trap 'exit 1' HUP INT TERM
  printf 'Downloading LILO %s.\n' "$ref"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 300 --output "$staging/source.tar.gz" \
    "https://api.github.com/repos/swappcloud/lilo/tarball/$ref"
  mkdir "$staging/source"
  tar -xzf "$staging/source.tar.gz" -C "$staging/source" --strip-components=1
  [ -f "$staging/source/scripts/install-headless.sh" ] || { printf '%s\n' 'This release does not contain the daemon installer.' >&2; return 1; }
  # Runtime profiles and pairing data stay outside replaceable release sources.
  mkdir -p "$install_dir/data" "$install_dir/releases"
  chmod 700 "$install_dir/data"
  if [ -e "$install_dir/releases/$ref" ]; then
    printf '%s\n' 'Reusing the installed release source.'
  else
    mv "$staging/source" "$install_dir/releases/$ref"
  fi
  source_dir=$install_dir/releases/$ref
  mkdir -p "$source_dir/.tmp"
  for directory in daemon-runtime daemon-phone; do
    mkdir -p "$install_dir/data/$directory"
    chmod 700 "$install_dir/data/$directory"
    if [ ! -e "$source_dir/.tmp/$directory" ]; then
      ln -s "$install_dir/data/$directory" "$source_dir/.tmp/$directory"
    fi
  done
  set --
  [ "$install_deps" = 0 ] || set -- "$@" --install-system-deps
  [ "$lan" = 0 ] || set -- "$@" --lan
  sh "$source_dir/scripts/install-headless.sh" "$@"
  ln -s "$source_dir" "$staging/current"
  mv -Tf "$staging/current" "$install_dir/current"
  printf 'Installed in %s/current.\n' "$install_dir"
}

main "$@"
