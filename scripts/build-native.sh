#!/usr/bin/env bash
# Builds the POSIX secure-files helper on Linux and macOS, plus the existing
# universal Swift helpers on macOS. Outputs stay in resources/native/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--linux" && "$(uname)" != "Linux" ]]; then
  echo "native: Linux packaging requires a Linux build host for secure-files-helper" >&2
  exit 1
fi

build_secure_files() {
  local src="$ROOT/native/secure-files/main.c"
  local out="$ROOT/resources/native/secure-files-helper"
  # Recompile this small security boundary on every build. A restored source
  # can have an older mtime than a binary produced by a verification mutation.
  mkdir -p "$(dirname "$out")"
  local tmp
  tmp="$(mktemp -d)"
  if [[ "$(uname)" == "Darwin" ]]; then
    cc -O2 -std=c11 -Wall -Wextra -Werror -target arm64-apple-macos11.0 "$src" -o "$tmp/arm64"
    cc -O2 -std=c11 -Wall -Wextra -Werror -target x86_64-apple-macos11.0 "$src" -o "$tmp/x86_64"
    lipo -create "$tmp/arm64" "$tmp/x86_64" -output "$tmp/secure-files-helper"
  else
    cc -O2 -std=c11 -Wall -Wextra -Werror "$src" -o "$tmp/secure-files-helper"
  fi
  chmod +x "$tmp/secure-files-helper"
  mv "$tmp/secure-files-helper" "$out"
  rm -rf "$tmp"
}

case "$(uname)" in
  Darwin|Linux) build_secure_files ;;
  *) echo "native: helpers unavailable on this platform, skipping"; exit 0 ;;
esac
if [[ "$(uname)" != "Darwin" ]]; then
  echo "native: not macOS, skipping Swift helpers"
  exit 0
fi

build_helper() {
  local name="$1"
  local src="$ROOT/native/$name/main.swift"
  local out="$ROOT/resources/native/$name-helper"

  if [[ -f "$out" && "$out" -nt "$src" ]]; then
    echo "native: $name-helper up to date"
    return 0
  fi

  mkdir -p "$(dirname "$out")"
  local tmp
  tmp="$(mktemp -d)"
  echo "native: compiling $name-helper (arm64 + x86_64)"
  swiftc -O -target arm64-apple-macos11.0 -o "$tmp/arm64" "$src"
  swiftc -O -target x86_64-apple-macos11.0 -o "$tmp/x86_64" "$src"
  lipo -create "$tmp/arm64" "$tmp/x86_64" -output "$out"
  chmod +x "$out"
  lipo -info "$out"
  rm -rf "$tmp"
}

build_helper mission-control
build_helper haptic
