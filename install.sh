#!/usr/bin/env bash
set -euo pipefail

APP_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/tabmonger.service"
PORT=${TABMONGER_PORT:-8787}
HOST=${TABMONGER_HOST:-0.0.0.0}

if ! command -v python3 >/dev/null 2>&1; then
  echo "TabMonger needs Python 3." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd was not found. Run TabMonger directly instead:" >&2
  printf 'python3 %q --host %q --port %q\n' "$APP_DIR/server.py" "$HOST" "$PORT" >&2
  exit 1
fi

mkdir -p "$SERVICE_DIR" "$APP_DIR/data" "$APP_DIR/assets/uploads"

if [[ -f "$SERVICE_FILE" ]]; then
  cp -- "$SERVICE_FILE" "$SERVICE_FILE.previous"
fi

escaped_dir=${APP_DIR//%/%%}
escaped_host=${HOST//%/%%}

printf '%s\n' \
  '[Unit]' \
  'Description=TabMonger lightweight launch dashboard' \
  'After=network.target' \
  '' \
  '[Service]' \
  'Type=simple' \
  "WorkingDirectory=$escaped_dir" \
  "ExecStart=/usr/bin/python3 $escaped_dir/server.py --host $escaped_host --port $PORT" \
  'Restart=on-failure' \
  'RestartSec=2' \
  '' \
  '[Install]' \
  'WantedBy=default.target' > "$SERVICE_FILE"

systemctl --user daemon-reload
systemctl --user enable --now tabmonger.service

address=$(hostname -I 2>/dev/null | awk '{print $1}')
printf '\nTabMonger is running.\n'
printf 'Local: http://127.0.0.1:%s\n' "$PORT"
if [[ -n "$address" ]]; then
  printf 'LAN:   http://%s:%s\n' "$address" "$PORT"
fi
printf '\nSettings and links stay in %s/data/.\n' "$APP_DIR"
