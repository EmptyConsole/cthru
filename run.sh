#!/usr/bin/env bash
# Start cthru.
#   ./run.sh          http://localhost:3000
#   ./run.sh phone    https://<LAN-IP>:3000  (camera on a phone on the same Wi-Fi)

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed. Using the portable Node.js launcher instead."
  exec "$(cd "$(dirname "$0")" && pwd)/serve.sh" "$@"
fi

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
    echo "Usage: ./run.sh [dev|phone]" >&2
    exit 1
    ;;
esac
