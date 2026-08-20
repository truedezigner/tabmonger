#!/usr/bin/env bash
set -euo pipefail

APP_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/tabmonger.service"
INSTALL_DIR=${TABMONGER_INSTALL_DIR:-$HOME/.local/lib/tabmonger}
PORT=${TABMONGER_PORT:-8787}
HOST=${TABMONGER_HOST:-0.0.0.0}

if [[ -n "${TABMONGER_DATA_DIR:-}" ]]; then
  DATA_DIR=$TABMONGER_DATA_DIR
  UPLOADS_DIR=${TABMONGER_UPLOADS_DIR:-$DATA_DIR/uploads}
elif [[ -f "$APP_DIR/data/tabmonger.db" ]]; then
  # Keep pre-portable installs on their existing untracked database and assets.
  DATA_DIR=$APP_DIR/data
  UPLOADS_DIR=$APP_DIR/assets/uploads
else
  DATA_DIR=${XDG_DATA_HOME:-$HOME/.local/share}/tabmonger
  UPLOADS_DIR=$DATA_DIR/uploads
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "TabMonger needs Python 3.10 or newer." >&2
  exit 1
fi

if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
  echo "TabMonger needs Python 3.10 or newer." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd was not found. Run TabMonger directly instead:" >&2
  printf 'python3 %q --host %q --port %q\n' "$APP_DIR/server.py" "$HOST" "$PORT" >&2
  exit 1
fi

mkdir -p "$SERVICE_DIR" "$INSTALL_DIR/public" "$DATA_DIR" "$UPLOADS_DIR"
chmod 700 "$DATA_DIR" "$UPLOADS_DIR"

if [[ "$INSTALL_DIR" != "$APP_DIR" ]]; then
  install -m 0755 "$APP_DIR/server.py" "$INSTALL_DIR/server.py"
  cp -a "$APP_DIR/public/." "$INSTALL_DIR/public/"
fi

if [[ -f "$SERVICE_FILE" ]]; then
  cp -- "$SERVICE_FILE" "$SERVICE_FILE.previous"
fi

unit_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  printf '%s' "$value"
}

escaped_install=$(unit_escape "$INSTALL_DIR")
escaped_data=$(unit_escape "$DATA_DIR")
escaped_uploads=$(unit_escape "$UPLOADS_DIR")
escaped_host=$(unit_escape "$HOST")

printf '%s\n' \
  '[Unit]' \
  'Description=TabMonger lightweight launch dashboard' \
  'After=network.target' \
  '' \
  '[Service]' \
  'Type=simple' \
  "WorkingDirectory=\"$escaped_install\"" \
  "Environment=\"TABMONGER_DATA_DIR=$escaped_data\"" \
  "Environment=\"TABMONGER_UPLOADS_DIR=$escaped_uploads\"" \
  "ExecStart=/usr/bin/python3 \"$escaped_install/server.py\" --host \"$escaped_host\" --port $PORT" \
  'Restart=on-failure' \
  'RestartSec=2' \
  '' \
  '[Install]' \
  'WantedBy=default.target' > "$SERVICE_FILE"

systemctl --user daemon-reload
systemctl --user enable tabmonger.service
systemctl --user restart tabmonger.service

address=$(hostname -I 2>/dev/null | awk '{print $1}')
printf '\nTabMonger is running.\n'
printf 'Local: http://127.0.0.1:%s\n' "$PORT"
if [[ -n "$address" ]]; then
  printf 'LAN:   http://%s:%s\n' "$address" "$PORT"
fi
printf '\nPrivate settings, links, and backups stay in %s/.\n' "$DATA_DIR"
printf 'Installed app files are in %s/.\n' "$INSTALL_DIR"
