#!/bin/bash
set -u

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
  printf '\nTabMonger needs Python 3.10 or newer, but a compatible python3 was not found.\n'
  printf 'Install the current Python 3 from python.org, then double-click this file again.\n\n'
  read -r -p 'Press Return to close...' _answer
  exit 1
fi

printf '\nStarting TabMonger for this Mac and your private local network...\n'
exec python3 "$APP_DIR/server.py" \
  --host "${TABMONGER_HOST:-0.0.0.0}" \
  --port "${TABMONGER_PORT:-8787}" \
  --find-port --open "$@"
