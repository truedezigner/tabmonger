#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/apps/tabmonger-site}
IMAGE_NAME=${IMAGE_NAME:-localhost/tabmonger-site:latest}
CONTAINER_NAME=${CONTAINER_NAME:-tabmonger-site}
PORT=${PORT:-4342}
PODMAN="sudo podman"
SERVICE_NAME="podman-managed-app@${CONTAINER_NAME}.service"
SERVICE_TEMPLATE="/etc/systemd/system/podman-managed-app@.service"
RUNTIME_ENV=${RUNTIME_ENV:-/opt/apps/data/tabmonger-site/runtime.env}

cd "$APP_DIR"

if ! sudo test -f "$SERVICE_TEMPLATE"; then
  echo "Missing shared Podman systemd service template: $SERVICE_TEMPLATE" >&2
  exit 1
fi

sudo systemctl enable "$SERVICE_NAME" >/dev/null
sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true

PUBLIC_STRIPE_SUPPORT_URL=""
PUBLIC_STRIPE_SUPPORT_READY="false"
if sudo test -f "$RUNTIME_ENV"; then
  PUBLIC_STRIPE_SUPPORT_URL=$(sudo sed -n 's/^PUBLIC_STRIPE_SUPPORT_URL=//p' "$RUNTIME_ENV" | tail -1)
  PUBLIC_STRIPE_SUPPORT_READY=$(sudo sed -n 's/^PUBLIC_STRIPE_SUPPORT_READY=//p' "$RUNTIME_ENV" | tail -1)
fi

$PODMAN build \
  --build-arg "PUBLIC_STRIPE_SUPPORT_URL=$PUBLIC_STRIPE_SUPPORT_URL" \
  --build-arg "PUBLIC_STRIPE_SUPPORT_READY=$PUBLIC_STRIPE_SUPPORT_READY" \
  -t "$IMAGE_NAME" -f Containerfile .

if $PODMAN container exists "$CONTAINER_NAME"; then
  $PODMAN rm -f "$CONTAINER_NAME"
fi

$PODMAN run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "$PORT:8080" \
  "$IMAGE_NAME"

sudo systemctl restart "$SERVICE_NAME"
$PODMAN ps --filter name="$CONTAINER_NAME"
printf '\nTabMonger website: http://127.0.0.1:%s\n' "$PORT"
