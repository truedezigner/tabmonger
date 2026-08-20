#!/usr/bin/env sh
set -u

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
  printf '\nTabMonger needs Python 3.10 or newer, but a compatible python3 was not found.\n'
  printf 'Install Python 3.10+ using your Linux software manager, then open this file again.\n\n'
  if [ -t 0 ]; then
    printf 'Press Enter to close...'
    read -r _answer
  fi
  exit 1
fi

printf '\nStarting TabMonger for this computer and your private local network...\n'
exec python3 "$APP_DIR/server.py" \
  --host "${TABMONGER_HOST:-0.0.0.0}" \
  --port "${TABMONGER_PORT:-8787}" \
  --find-port --open "$@"
