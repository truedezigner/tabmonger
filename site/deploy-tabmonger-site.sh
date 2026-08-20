#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/apps/tabmonger-site}
IMAGE_REPOSITORY=${IMAGE_REPOSITORY:-localhost/tabmonger-site}
IMAGE_NAME=${IMAGE_NAME:-${IMAGE_REPOSITORY}:latest}
CONTAINER_NAME=${CONTAINER_NAME:-tabmonger-site}
PORT=${PORT:-4342}
PODMAN="sudo podman"
SERVICE_NAME="podman-managed-app@${CONTAINER_NAME}.service"
SERVICE_TEMPLATE="/etc/systemd/system/podman-managed-app@.service"
RUNTIME_ENV=${RUNTIME_ENV:-/opt/apps/data/tabmonger-site/runtime.env}
DEPLOY_ID=${DEPLOY_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
CANDIDATE_IMAGE="${IMAGE_REPOSITORY}:candidate-${DEPLOY_ID}"
CANDIDATE_CONTAINER="${CONTAINER_NAME}-candidate-${DEPLOY_ID}"
ROLLBACK_IMAGE="${IMAGE_REPOSITORY}:rollback-${DEPLOY_ID}"
CANDIDATE_BODY=""
CANDIDATE_HEADERS=""
CUTOVER_STARTED=false
ROLLBACK_AVAILABLE=false

cleanup() {
  if [ -n "$CANDIDATE_BODY" ]; then sudo rm -f "$CANDIDATE_BODY"; fi
  if [ -n "$CANDIDATE_HEADERS" ]; then sudo rm -f "$CANDIDATE_HEADERS"; fi
  $PODMAN rm -f "$CANDIDATE_CONTAINER" >/dev/null 2>&1 || true
}

restore_previous() {
  if [ "$CUTOVER_STARTED" != true ] || [ "$ROLLBACK_AVAILABLE" != true ]; then
    return
  fi
  echo "Candidate cutover failed; restoring the previous container." >&2
  sudo systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  $PODMAN rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  $PODMAN run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -p "$PORT:8080" \
    "$ROLLBACK_IMAGE" >/dev/null || return 1
  sudo systemctl restart "$SERVICE_NAME" || return 1
  for attempt in $(seq 1 30); do
    if sudo curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/"; then
      echo "Previous container restored successfully." >&2
      return 0
    fi
    sleep 1
  done
  return 1
}

on_error() {
  status=$?
  if ! restore_previous; then
    echo "CRITICAL: automatic rollback did not become healthy; inspect ${SERVICE_NAME}." >&2
  fi
  cleanup
  exit "$status"
}

trap on_error ERR
trap cleanup EXIT

cd "$APP_DIR"

if ! sudo test -f "$SERVICE_TEMPLATE"; then
  echo "Missing shared Podman systemd service template: $SERVICE_TEMPLATE" >&2
  exit 1
fi

PUBLIC_SUPPORT_URL=""
PUBLIC_STRIPE_SUPPORT_URL=""
PUBLIC_STRIPE_SUPPORT_READY="false"
if sudo test -f "$RUNTIME_ENV"; then
  PUBLIC_SUPPORT_URL=$(sudo sed -n 's/^PUBLIC_SUPPORT_URL=//p' "$RUNTIME_ENV" | tail -1)
  PUBLIC_STRIPE_SUPPORT_URL=$(sudo sed -n 's/^PUBLIC_STRIPE_SUPPORT_URL=//p' "$RUNTIME_ENV" | tail -1)
  PUBLIC_STRIPE_SUPPORT_READY=$(sudo sed -n 's/^PUBLIC_STRIPE_SUPPORT_READY=//p' "$RUNTIME_ENV" | tail -1)
fi

echo "Building and validating a candidate while the current site stays online."
$PODMAN build \
  --build-arg "PUBLIC_SUPPORT_URL=$PUBLIC_SUPPORT_URL" \
  --build-arg "PUBLIC_STRIPE_SUPPORT_URL=$PUBLIC_STRIPE_SUPPORT_URL" \
  --build-arg "PUBLIC_STRIPE_SUPPORT_READY=$PUBLIC_STRIPE_SUPPORT_READY" \
  -t "$CANDIDATE_IMAGE" -f Containerfile .

$PODMAN run -d \
  --name "$CANDIDATE_CONTAINER" \
  -p 127.0.0.1::8080 \
  "$CANDIDATE_IMAGE" >/dev/null

CANDIDATE_ENDPOINT=$($PODMAN port "$CANDIDATE_CONTAINER" 8080/tcp | tail -1)
CANDIDATE_PORT=${CANDIDATE_ENDPOINT##*:}
if ! [[ "$CANDIDATE_PORT" =~ ^[0-9]+$ ]]; then
  echo "Could not determine the candidate HTTP port." >&2
  exit 1
fi

CANDIDATE_BODY=$(sudo mktemp)
CANDIDATE_HEADERS=$(sudo mktemp)
CANDIDATE_URL="http://127.0.0.1:${CANDIDATE_PORT}/"
for attempt in $(seq 1 30); do
  if sudo curl -fsS -D "$CANDIDATE_HEADERS" -o "$CANDIDATE_BODY" "$CANDIDATE_URL"; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "Candidate did not become healthy." >&2
    exit 1
  fi
  sleep 1
done

sudo grep -qi '^Content-Security-Policy:' "$CANDIDATE_HEADERS"
sudo grep -q 'Your tabs\.' "$CANDIDATE_BODY"
sudo grep -q 'Your rules\.' "$CANDIDATE_BODY"
if [ "$PUBLIC_STRIPE_SUPPORT_READY" = "true" ]; then
  SUPPORT_LINK_COUNT=$(sudo grep -o 'href="https://buy\.stripe\.com/[^" ]*"' "$CANDIDATE_BODY" | wc -l)
  if [ "$SUPPORT_LINK_COUNT" -ne 3 ]; then
    echo "Candidate must contain exactly three active Stripe support links." >&2
    exit 1
  fi
  if sudo grep -q 'Contributions opening soon' "$CANDIDATE_BODY"; then
    echo "Candidate unexpectedly contains pending-support controls." >&2
    exit 1
  fi
else
  sudo grep -q 'Contributions opening soon' "$CANDIDATE_BODY"
  if sudo grep -q 'href="https://buy\.stripe\.com/' "$CANDIDATE_BODY"; then
    echo "Candidate exposes an active Stripe link while support is disabled." >&2
    exit 1
  fi
fi

if $PODMAN container exists "$CONTAINER_NAME"; then
  CURRENT_IMAGE_ID=$($PODMAN inspect --format '{{.Image}}' "$CONTAINER_NAME")
  $PODMAN tag "$CURRENT_IMAGE_ID" "$ROLLBACK_IMAGE"
  ROLLBACK_AVAILABLE=true
fi

echo "Candidate passed. Switching the local origin with rollback protection."
sudo systemctl enable "$SERVICE_NAME" >/dev/null
CUTOVER_STARTED=true
sudo systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
if $PODMAN container exists "$CONTAINER_NAME"; then
  $PODMAN rm -f "$CONTAINER_NAME" >/dev/null
fi
$PODMAN run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "$PORT:8080" \
  "$CANDIDATE_IMAGE" >/dev/null
sudo systemctl restart "$SERVICE_NAME"

for attempt in $(seq 1 30); do
  if sudo curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/"; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "New local origin did not become healthy." >&2
    exit 1
  fi
  sleep 1
done

$PODMAN tag "$CANDIDATE_IMAGE" "$IMAGE_NAME"
CUTOVER_STARTED=false
trap - ERR
$PODMAN ps --filter name="$CONTAINER_NAME"
printf '\nTabMonger website: http://127.0.0.1:%s\n' "$PORT"
if [ "$ROLLBACK_AVAILABLE" = true ]; then
  printf 'Rollback image preserved: %s\n' "$ROLLBACK_IMAGE"
fi
