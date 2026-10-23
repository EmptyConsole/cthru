#!/usr/bin/env bash
# Start cthru without a system-wide Node.js or npm.
# The first run downloads a portable Node.js (npm is included) into .local-node/.
#
#   ./serve.sh          http://localhost:3000
#   ./serve.sh phone    https://<LAN-IP>:3000  (camera on a phone on the same Wi-Fi)

set -euo pipefail

cd "$(dirname "$0")"

LOCAL="$(pwd)/.local-node"
NODE_MAJOR=22

platform_triple() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *)
      echo "This launcher supports macOS and Linux. Detected: $os" >&2
      exit 1
      ;;
  esac
  case "$arch" in
    arm64|aarch64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *)
      echo "Unsupported CPU architecture: $arch" >&2
      exit 1
      ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

ensure_local_node() {
  if [[ -x "$LOCAL/bin/npm" ]]; then
    return
  fi

  local triple version base url tmp archive
  triple="$(platform_triple)"
  echo "Downloading a portable Node.js (npm is included)..."

  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  version="$(
    curl -fsSL "$base/SHASUMS256.txt" \
      | sed -nE 's/.*node-(v[0-9]+\.[0-9]+\.[0-9]+)-.*/\1/p' \
      | head -n 1
  )"
  if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Could not determine which Node.js version to download." >&2
    exit 1
  fi

  archive="node-${version}-${triple}.tar.gz"
  url="$base/$archive"
  tmp="$(mktemp -d)"

  curl -fL "$url" -o "$tmp/$archive"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (
    cd "$tmp"
    grep -F "$archive" SHASUMS256.txt | shasum -a 256 -c -
  )

  tar -xzf "$tmp/$archive" -C "$tmp"
  rm -rf "$LOCAL"
  mv "$tmp/node-${version}-${triple}" "$LOCAL"
  rm -rf "$tmp"
  echo "Using $($LOCAL/bin/node -v) from .local-node/"
}

ensure_local_node
export PATH="$LOCAL/bin:$PATH"

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install
fi

mode="${1:-dev}"
case "$mode" in
  dev|"")
    exec npm run dev
    ;;
  phone)
    exec npm run dev:phone
    ;;
  *)
    echo "Usage: ./serve.sh [dev|phone]" >&2
    exit 1
    ;;
esac
