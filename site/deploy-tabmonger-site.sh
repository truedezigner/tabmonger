#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/apps/tabmonger-site}
DATA_ROOT=${DATA_ROOT:-/opt/apps/data/tabmonger-site}
RUNTIME_ENV=${RUNTIME_ENV:-${DATA_ROOT}/runtime.env}
COMMUNITY_DATA_DIR=${COMMUNITY_DATA_DIR:-${DATA_ROOT}/community}
BACKUP_ROOT=${BACKUP_ROOT:-${DATA_ROOT}/backups}
PORT=${PORT:-4342}
METRICS_PORT=${METRICS_PORT:-4343}
CANDIDATE_PUBLIC_PORT=${CANDIDATE_PUBLIC_PORT:-54342}
CANDIDATE_METRICS_PORT=${CANDIDATE_METRICS_PORT:-54343}
POD_NAME=${POD_NAME:-tabmonger-community}
SITE_CONTAINER=${SITE_CONTAINER:-tabmonger-site}
API_CONTAINER=${API_CONTAINER:-tabmonger-community-api}
SITE_IMAGE_REPOSITORY=${SITE_IMAGE_REPOSITORY:-localhost/tabmonger-site}
API_IMAGE_REPOSITORY=${API_IMAGE_REPOSITORY:-localhost/tabmonger-community-api}
SITE_IMAGE_NAME=${SITE_IMAGE_NAME:-${SITE_IMAGE_REPOSITORY}:latest}
API_IMAGE_NAME=${API_IMAGE_NAME:-${API_IMAGE_REPOSITORY}:latest}
OLD_SERVICE=${OLD_SERVICE:-podman-managed-app@tabmonger-site.service}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
DEPLOY_ID=${DEPLOY_ID:-$(date -u +%Y%m%dT%H%M%SZ)}

SITE_CANDIDATE_IMAGE="${SITE_IMAGE_REPOSITORY}:candidate-${DEPLOY_ID}"
API_CANDIDATE_IMAGE="${API_IMAGE_REPOSITORY}:candidate-${DEPLOY_ID}"
SITE_ROLLBACK_IMAGE="${SITE_IMAGE_REPOSITORY}:rollback-${DEPLOY_ID}"
API_ROLLBACK_IMAGE="${API_IMAGE_REPOSITORY}:rollback-${DEPLOY_ID}"
CANDIDATE_POD="${POD_NAME}-candidate-${DEPLOY_ID}"
CANDIDATE_SITE="${SITE_CONTAINER}-candidate-${DEPLOY_ID}"
CANDIDATE_API="${API_CONTAINER}-candidate-${DEPLOY_ID}"
POD_SERVICE="pod-${POD_NAME}.service"

CANDIDATE_DATA=""
CANDIDATE_BODY=""
CANDIDATE_HEADERS=""
CANDIDATE_RESPONSE=""
UNIT_STAGING=""
PREVIOUS_MODE="none"
CUTOVER_STARTED=false
ROLLBACK_AVAILABLE=false

podman_cmd() {
  sudo podman "$@"
}

pod_exists() {
  podman_cmd pod inspect "$1" >/dev/null 2>&1
}

container_exists() {
  podman_cmd container exists "$1"
}

remove_path_if_candidate() {
  target=${1:-}
  case "$target" in
    "${DATA_ROOT}"/.community-candidate-*) sudo rm -rf -- "$target" ;;
    /tmp/tabmonger-unit-staging-*) sudo rm -rf -- "$target" ;;
    *) return 0 ;;
  esac
}

cleanup() {
  podman_cmd pod rm -f "$CANDIDATE_POD" >/dev/null 2>&1 || true
  podman_cmd rm -f "$CANDIDATE_SITE" "$CANDIDATE_API" >/dev/null 2>&1 || true
  for temporary_file in "$CANDIDATE_BODY" "$CANDIDATE_HEADERS" "$CANDIDATE_RESPONSE"; do
    if [ -n "$temporary_file" ]; then sudo rm -f -- "$temporary_file"; fi
  done
  remove_path_if_candidate "$CANDIDATE_DATA"
  remove_path_if_candidate "$UNIT_STAGING"
}

create_stack() {
  stack_pod=$1
  stack_api=$2
  stack_site=$3
  public_publish=$4
  metrics_publish=$5
  data_directory=$6
  api_image=$7
  site_image=$8

  podman_cmd pod create \
    --name "$stack_pod" \
    -p "$public_publish" \
    -p "$metrics_publish" >/dev/null

  podman_cmd run -d \
    --pod "$stack_pod" \
    --name "$stack_api" \
    --env-file "$RUNTIME_ENV" \
    -e HOST=127.0.0.1 \
    -e PORT=8081 \
    -e COMMUNITY_DATA_DIR=/data/community \
    -e COMMUNITY_ADMIN_SOCKET=/data/community/admin.sock \
    -e COMMUNITY_TRUST_PROXY=1 \
    --user 10001:10001 \
    --cap-drop all \
    --security-opt no-new-privileges \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
    -v "${data_directory}:/data/community:rw" \
    "$api_image" >/dev/null

  podman_cmd run -d \
    --pod "$stack_pod" \
    --name "$stack_site" \
    "$site_image" >/dev/null
}

wait_for_api() {
  api_name=$1
  for attempt in $(seq 1 30); do
    if podman_cmd exec "$api_name" node -e "fetch('http://127.0.0.1:8081/api/community/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
      return 0
    fi
    if [ "$attempt" -eq 30 ]; then return 1; fi
    sleep 1
  done
}

wait_for_site() {
  url=$1
  for attempt in $(seq 1 30); do
    if sudo curl --connect-timeout 2 --max-time 5 -fsS -o /dev/null "$url"; then return 0; fi
    if [ "$attempt" -eq 30 ]; then return 1; fi
    sleep 1
  done
}

install_generated_units() {
  remove_path_if_candidate "$UNIT_STAGING"
  UNIT_STAGING=$(mktemp -d "/tmp/tabmonger-unit-staging-${DEPLOY_ID}.XXXXXX")
  (
    cd "$UNIT_STAGING"
    podman_cmd generate systemd --name --files --restart-policy=on-failure "$POD_NAME" >/dev/null
  )
  if ! sudo test -f "${UNIT_STAGING}/${POD_SERVICE}"; then
    echo "Generated Podman pod unit is missing: ${POD_SERVICE}" >&2
    return 1
  fi
  for unit in "${UNIT_STAGING}"/*.service; do
    sudo install -m 0644 "$unit" "${SYSTEMD_DIR}/$(basename "$unit")"
  done
  sudo systemctl daemon-reload
  sudo systemctl enable "$POD_SERVICE" >/dev/null
}

install_metrics_timer() {
  sudo install -m 0755 "${APP_DIR}/generate-weekly-report.sh" /usr/local/sbin/tabmonger-generate-weekly-report
  sudo install -m 0644 "${APP_DIR}/tabmonger-metrics-report.service" "${SYSTEMD_DIR}/tabmonger-metrics-report.service"
  sudo install -m 0644 "${APP_DIR}/tabmonger-metrics-report.timer" "${SYSTEMD_DIR}/tabmonger-metrics-report.timer"
  sudo systemctl daemon-reload
  sudo systemctl enable --now tabmonger-metrics-report.timer >/dev/null
}

verify_live_stack() {
  wait_for_api "$API_CONTAINER"
  wait_for_site "http://127.0.0.1:${PORT}/"

  infra_id=$(podman_cmd pod inspect --format '{{.InfraContainerID}}' "$POD_NAME")
  endpoint=$(podman_cmd port "$infra_id" 8080/tcp | tail -1)
  if [ "$endpoint" != "127.0.0.1:${PORT}" ]; then
    echo "Origin is not bound exclusively to the expected loopback endpoint." >&2
    return 1
  fi
  metrics_endpoint=$(podman_cmd port "$infra_id" 8082/tcp | tail -1)
  if [ "$metrics_endpoint" != "0.0.0.0:${METRICS_PORT}" ]; then
    echo "Metrics are not bound to the expected private-network host port." >&2
    return 1
  fi
  if [ "$(podman_cmd exec "$API_CONTAINER" id -u)" != "10001" ]; then
    echo "Community API is not running as its dedicated non-root user." >&2
    return 1
  fi
  sudo curl -fsS "http://127.0.0.1:${PORT}/api/community/poll" | sudo grep -q '"items"'
  sudo curl -fsS "http://127.0.0.1:${METRICS_PORT}/metrics/" | sudo grep -q 'Private project pulse'
  sudo curl -fsS "http://127.0.0.1:${METRICS_PORT}/api/analytics/report?days=30" | sudo grep -q '"totals"'
  admin_status=$(sudo curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/community/admin")
  health_status=$(sudo curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/community/health")
  report_status=$(sudo curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/analytics/report")
  metrics_status=$(sudo curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/metrics/")
  [ "$admin_status" = 404 ] && [ "$health_status" = 404 ] && [ "$report_status" = 404 ] && [ "$metrics_status" = 404 ]
}

stop_current_stack() {
  sudo systemctl disable --now "$OLD_SERVICE" >/dev/null 2>&1 || true
  sudo systemctl disable --now "$POD_SERVICE" >/dev/null 2>&1 || true
  if pod_exists "$POD_NAME"; then podman_cmd pod rm -f "$POD_NAME" >/dev/null; fi
  if container_exists "$SITE_CONTAINER"; then podman_cmd rm -f "$SITE_CONTAINER" >/dev/null; fi
  if container_exists "$API_CONTAINER"; then podman_cmd rm -f "$API_CONTAINER" >/dev/null; fi
}

restore_previous() {
  if [ "$CUTOVER_STARTED" != true ] || [ "$ROLLBACK_AVAILABLE" != true ]; then
    return 0
  fi

  echo "Candidate cutover failed; restoring the previous application while preserving community data." >&2
  stop_current_stack

  if [ "$PREVIOUS_MODE" = "static" ]; then
    podman_cmd run -d \
      --name "$SITE_CONTAINER" \
      --restart unless-stopped \
      -p "127.0.0.1:${PORT}:8080" \
      "$SITE_ROLLBACK_IMAGE" >/dev/null || return 1
    sudo systemctl enable "$OLD_SERVICE" >/dev/null
    sudo systemctl restart "$OLD_SERVICE" || return 1
    wait_for_site "http://127.0.0.1:${PORT}/" || return 1
  elif [ "$PREVIOUS_MODE" = "pod" ]; then
    create_stack \
      "$POD_NAME" "$API_CONTAINER" "$SITE_CONTAINER" \
      "127.0.0.1:${PORT}:8080" "0.0.0.0:${METRICS_PORT}:8082" "$COMMUNITY_DATA_DIR" \
      "$API_ROLLBACK_IMAGE" "$SITE_ROLLBACK_IMAGE" || return 1
    install_generated_units || return 1
    podman_cmd pod stop "$POD_NAME" >/dev/null || return 1
    sudo systemctl start "$POD_SERVICE" || return 1
    wait_for_api "$API_CONTAINER" || return 1
    wait_for_site "http://127.0.0.1:${PORT}/" || return 1
    sudo curl -fsS "http://127.0.0.1:${PORT}/api/community/poll" | sudo grep -q '"items"' || return 1
  fi

  echo "Previous application restored successfully." >&2
}

on_error() {
  status=$?
  echo "Deployment stopped at line ${BASH_LINENO[0]}. Production rollback rules are being applied." >&2
  if ! restore_previous; then
    echo "CRITICAL: automatic rollback did not become healthy; inspect TabMonger on the app host." >&2
  fi
  cleanup
  exit "$status"
}

trap on_error ERR
trap cleanup EXIT

cd "$APP_DIR"

sudo install -d -m 0700 "$DATA_ROOT" "$BACKUP_ROOT"
sudo install -d -m 0700 -o 10001 -g 10001 "$COMMUNITY_DATA_DIR"
if ! sudo test -f "$RUNTIME_ENV"; then
  sudo install -m 0600 /dev/null "$RUNTIME_ENV"
fi
sudo chmod 0600 "$RUNTIME_ENV"

COMMUNITY_HASH_SALT=$(sudo sed -n 's/^COMMUNITY_HASH_SALT=//p' "$RUNTIME_ENV" | tail -1)
if [ -z "$COMMUNITY_HASH_SALT" ]; then
  COMMUNITY_HASH_SALT=$(openssl rand -hex 32)
  printf 'COMMUNITY_HASH_SALT=%s\n' "$COMMUNITY_HASH_SALT" | sudo tee -a "$RUNTIME_ENV" >/dev/null
fi
if [ "${#COMMUNITY_HASH_SALT}" -lt 32 ]; then
  echo "The protected community hash salt is invalid; deployment stopped." >&2
  exit 1
fi
unset COMMUNITY_HASH_SALT

PUBLIC_SUPPORT_URL=""
PUBLIC_STRIPE_SUPPORT_URL=""
PUBLIC_STRIPE_SUPPORT_READY="false"
PUBLIC_SUPPORT_URL=$(sudo sed -n 's/^PUBLIC_SUPPORT_URL=//p' "$RUNTIME_ENV" | tail -1)
PUBLIC_STRIPE_SUPPORT_URL=$(sudo sed -n 's/^PUBLIC_STRIPE_SUPPORT_URL=//p' "$RUNTIME_ENV" | tail -1)
PUBLIC_STRIPE_SUPPORT_READY=$(sudo sed -n 's/^PUBLIC_STRIPE_SUPPORT_READY=//p' "$RUNTIME_ENV" | tail -1)

if pod_exists "$POD_NAME" && container_exists "$SITE_CONTAINER" && container_exists "$API_CONTAINER"; then
  PREVIOUS_MODE="pod"
  current_site_image=$(podman_cmd inspect --format '{{.Image}}' "$SITE_CONTAINER")
  current_api_image=$(podman_cmd inspect --format '{{.Image}}' "$API_CONTAINER")
  podman_cmd tag "$current_site_image" "$SITE_ROLLBACK_IMAGE"
  podman_cmd tag "$current_api_image" "$API_ROLLBACK_IMAGE"
  ROLLBACK_AVAILABLE=true
elif container_exists "$SITE_CONTAINER"; then
  PREVIOUS_MODE="static"
  current_site_image=$(podman_cmd inspect --format '{{.Image}}' "$SITE_CONTAINER")
  podman_cmd tag "$current_site_image" "$SITE_ROLLBACK_IMAGE"
  ROLLBACK_AVAILABLE=true
fi

BACKUP_PATH="${BACKUP_ROOT}/${DEPLOY_ID}"
sudo install -d -m 0700 "$BACKUP_PATH"
sudo install -m 0600 "$RUNTIME_ENV" "${BACKUP_PATH}/runtime.env"
printf '%s\n' "$PREVIOUS_MODE" | sudo tee "${BACKUP_PATH}/previous-mode" >/dev/null
sudo chmod 0600 "${BACKUP_PATH}/previous-mode"
if sudo test -f "${COMMUNITY_DATA_DIR}/community.json"; then
  sudo install -m 0600 "${COMMUNITY_DATA_DIR}/community.json" "${BACKUP_PATH}/community.json"
  sudo sha256sum "${BACKUP_PATH}/community.json" | sudo tee "${BACKUP_PATH}/community.json.sha256" >/dev/null
  sudo chmod 0600 "${BACKUP_PATH}/community.json.sha256"
  sudo sha256sum -c "${BACKUP_PATH}/community.json.sha256" >/dev/null
fi
if sudo test -f "${COMMUNITY_DATA_DIR}/analytics.ndjson"; then
  sudo install -m 0600 "${COMMUNITY_DATA_DIR}/analytics.ndjson" "${BACKUP_PATH}/analytics.ndjson"
  sudo sha256sum "${BACKUP_PATH}/analytics.ndjson" | sudo tee "${BACKUP_PATH}/analytics.ndjson.sha256" >/dev/null
  sudo chmod 0600 "${BACKUP_PATH}/analytics.ndjson.sha256"
  sudo sha256sum -c "${BACKUP_PATH}/analytics.ndjson.sha256" >/dev/null
fi
sudo find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??????T??????Z' -mtime +29 -exec rm -rf -- {} +

CANDIDATE_DATA=$(sudo mktemp -d "${DATA_ROOT}/.community-candidate-${DEPLOY_ID}.XXXXXX")
sudo chown 10001:10001 "$CANDIDATE_DATA"
sudo chmod 0700 "$CANDIDATE_DATA"
if sudo test -f "${BACKUP_PATH}/community.json"; then
  sudo install -m 0600 -o 10001 -g 10001 "${BACKUP_PATH}/community.json" "${CANDIDATE_DATA}/community.json"
fi
if sudo test -f "${BACKUP_PATH}/analytics.ndjson"; then
  sudo install -m 0600 -o 10001 -g 10001 "${BACKUP_PATH}/analytics.ndjson" "${CANDIDATE_DATA}/analytics.ndjson"
fi

echo "Building and validating isolated website and community-service candidates."
podman_cmd build \
  --build-arg "PUBLIC_SUPPORT_URL=$PUBLIC_SUPPORT_URL" \
  --build-arg "PUBLIC_STRIPE_SUPPORT_URL=$PUBLIC_STRIPE_SUPPORT_URL" \
  --build-arg "PUBLIC_STRIPE_SUPPORT_READY=$PUBLIC_STRIPE_SUPPORT_READY" \
  -t "$SITE_CANDIDATE_IMAGE" -f Containerfile .
podman_cmd build -t "$API_CANDIDATE_IMAGE" -f community/Containerfile .

create_stack \
  "$CANDIDATE_POD" "$CANDIDATE_API" "$CANDIDATE_SITE" \
  "127.0.0.1:${CANDIDATE_PUBLIC_PORT}:8080" "127.0.0.1:${CANDIDATE_METRICS_PORT}:8082" "$CANDIDATE_DATA" \
  "$API_CANDIDATE_IMAGE" "$SITE_CANDIDATE_IMAGE"

candidate_infra=$(podman_cmd pod inspect --format '{{.InfraContainerID}}' "$CANDIDATE_POD")
candidate_endpoint=$(podman_cmd port "$candidate_infra" 8080/tcp | tail -1)
if ! [[ "$candidate_endpoint" =~ ^127\.0\.0\.1:[0-9]+$ ]]; then
  echo "Candidate endpoint is not an isolated loopback port." >&2
  exit 1
fi
CANDIDATE_URL="http://${candidate_endpoint}"
candidate_metrics_endpoint=$(podman_cmd port "$candidate_infra" 8082/tcp | tail -1)
if ! [[ "$candidate_metrics_endpoint" =~ ^127\.0\.0\.1:[0-9]+$ ]]; then
  echo "Candidate metrics endpoint is not an isolated loopback port." >&2
  exit 1
fi
CANDIDATE_METRICS_URL="http://${candidate_metrics_endpoint}"
wait_for_api "$CANDIDATE_API"
wait_for_site "${CANDIDATE_URL}/"

CANDIDATE_BODY=$(sudo mktemp)
CANDIDATE_HEADERS=$(sudo mktemp)
CANDIDATE_RESPONSE=$(sudo mktemp)
sudo curl -fsS -D "$CANDIDATE_HEADERS" -o "$CANDIDATE_BODY" "${CANDIDATE_URL}/"
sudo grep -qi '^Content-Security-Policy:.*connect-src' "$CANDIDATE_HEADERS"
sudo grep -q 'Your tabs\.' "$CANDIDATE_BODY"
sudo grep -q 'Your rules\.' "$CANDIDATE_BODY"
sudo grep -Fq 'data-community-form' "$CANDIDATE_BODY"
sudo grep -Fq 'action="/api/community/submissions"' "$CANDIDATE_BODY"
sudo grep -Fq 'data-community-poll' "$CANDIDATE_BODY"
sudo grep -Fq 'site-analytics.js?v=3' "$CANDIDATE_BODY"
for analytics_event in \
  download_macos \
  download_windows \
  download_linux \
  download_chromium \
  download_firefox; do
  sudo grep -Fq "data-analytics-event=\"${analytics_event}\"" "$CANDIDATE_BODY"
done
sudo grep -Fq 'Nothing is added to the poll automatically.' "$CANDIDATE_BODY"
sudo grep -Fq 'Feature details and general feedback stay private.' "$CANDIDATE_BODY"
for release_asset in \
  TabMonger-portable.zip \
  TabMonger-Chromium-extension.zip \
  TabMonger-Firefox-extension.zip; do
  sudo grep -Fq "href=\"https://github.com/truedezigner/tabmonger/releases/latest/download/${release_asset}\"" "$CANDIDATE_BODY"
done
sudo grep -Fq 'Start TabMonger.command' "$CANDIDATE_BODY"
sudo grep -Fq 'Standard Firefox installation is temporary until Mozilla signing' "$CANDIDATE_BODY"

if [ "$PUBLIC_STRIPE_SUPPORT_READY" = "true" ]; then
  support_link_count=$(sudo grep -o 'href="https://buy\.stripe\.com/[^" ]*"' "$CANDIDATE_BODY" | wc -l)
  if [ "$support_link_count" -ne 3 ]; then
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

feature_title="Candidate feature ${DEPLOY_ID}"
feature_detail="Private candidate detail ${DEPLOY_ID}"
status=$(sudo curl -sS -o "$CANDIDATE_RESPONSE" -w '%{http_code}' \
  -H 'Origin: https://tabmonger.com' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'CF-Connecting-IP: 192.0.2.10' \
  -H 'Content-Type: application/json' \
  --data "{\"kind\":\"feature\",\"title\":\"${feature_title}\",\"details\":\"${feature_detail}\",\"website\":\"\"}" \
  "${CANDIDATE_URL}/api/community/submissions")
[ "$status" = 202 ]
if sudo curl -fsS "${CANDIDATE_URL}/api/community/poll" | sudo grep -Fq "$feature_title"; then
  echo "Pending candidate feature leaked into the public poll." >&2
  exit 1
fi

submission_id=$(podman_cmd exec "$CANDIDATE_API" node moderate.mjs list --status pending --kind feature --limit 1000 \
  | awk -F '\t' -v title="$feature_title" '$5 == title { print $1; exit }')
if ! [[ "$submission_id" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "Candidate moderation queue did not contain the submitted feature." >&2
  exit 1
fi
podman_cmd exec "$CANDIDATE_API" node moderate.mjs approve "$submission_id" >/dev/null
poll_item_id=$(podman_cmd exec "$CANDIDATE_API" node moderate.mjs poll \
  | awk -F '\t' -v title="$feature_title" '$4 == title { print $1; exit }')
if ! [[ "$poll_item_id" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "Approved candidate title did not enter the poll." >&2
  exit 1
fi
sudo curl -fsS -D "$CANDIDATE_HEADERS" -o "$CANDIDATE_RESPONSE" "${CANDIDATE_URL}/api/community/poll"
sudo grep -qi '^Cache-Control:.*no-store' "$CANDIDATE_HEADERS"
if sudo grep -qi '^Access-Control-Allow-Origin:' "$CANDIDATE_HEADERS"; then
  echo "Candidate community API unexpectedly enables CORS." >&2
  exit 1
fi
sudo grep -Fq "$feature_title" "$CANDIDATE_RESPONSE"
if sudo grep -Fq "$feature_detail" "$CANDIDATE_RESPONSE"; then
  echo "Private candidate details leaked into the public poll." >&2
  exit 1
fi

status=$(sudo curl -sS -o "$CANDIDATE_RESPONSE" -w '%{http_code}' \
  -H 'Origin: https://tabmonger.com' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'CF-Connecting-IP: 192.0.2.11' \
  -H 'Content-Type: application/json' \
  --data "{\"featureId\":\"${poll_item_id}\",\"voterId\":\"11111111-1111-4111-8111-111111111111\"}" \
  "${CANDIDATE_URL}/api/community/vote")
[ "$status" = 200 ]

feedback_title="Candidate feedback ${DEPLOY_ID}"
status=$(sudo curl -sS -o "$CANDIDATE_RESPONSE" -w '%{http_code}' \
  -H 'Origin: https://tabmonger.com' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'CF-Connecting-IP: 192.0.2.12' \
  -H 'Content-Type: application/json' \
  --data "{\"kind\":\"feedback\",\"title\":\"${feedback_title}\",\"details\":\"Private general candidate feedback.\",\"website\":\"\"}" \
  "${CANDIDATE_URL}/api/community/submissions")
[ "$status" = 202 ]
if sudo curl -fsS "${CANDIDATE_URL}/api/community/poll" | sudo grep -Fq "$feedback_title"; then
  echo "General feedback leaked into the public poll." >&2
  exit 1
fi

blocked_status=$(sudo curl -sS -o "$CANDIDATE_RESPONSE" -w '%{http_code}' \
  -H 'Origin: https://tabmonger.com' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'CF-Connecting-IP: 192.0.2.13' \
  -H 'Content-Type: application/json' \
  --data '{"kind":"feature","title":"Visit bad.example.com","details":"This should be rejected by filtering.","website":""}' \
  "${CANDIDATE_URL}/api/community/submissions")
[ "$blocked_status" = 400 ]
foreign_status=$(sudo curl -sS -o "$CANDIDATE_RESPONSE" -w '%{http_code}' \
  -H 'Origin: https://example.invalid' \
  -H 'Content-Type: application/json' \
  --data '{"kind":"feedback","title":"Foreign request","details":"This origin must be rejected.","website":""}' \
  "${CANDIDATE_URL}/api/community/submissions")
[ "$foreign_status" = 403 ]
admin_status=$(sudo curl -sS -o /dev/null -w '%{http_code}' "${CANDIDATE_URL}/api/community/admin")
health_status=$(sudo curl -sS -o /dev/null -w '%{http_code}' "${CANDIDATE_URL}/api/community/health")
[ "$admin_status" = 404 ] && [ "$health_status" = 404 ]

analytics_status=$(sudo curl -sS -o "$CANDIDATE_RESPONSE" -w '%{http_code}' \
  -H 'Origin: https://tabmonger.com' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'CF-Connecting-IP: 192.0.2.14' \
  -H 'Content-Type: application/json' \
  --data '{"event":"page_view","source":"direct"}' \
  "${CANDIDATE_URL}/api/analytics/event")
[ "$analytics_status" = 202 ]
sudo curl -fsS "${CANDIDATE_METRICS_URL}/metrics/" | sudo grep -Fq 'Private project pulse'
sudo curl -fsS "${CANDIDATE_METRICS_URL}/api/analytics/report?days=30" | sudo grep -Eq '"page_view":[1-9][0-9]*'
public_report_status=$(sudo curl -sS -o /dev/null -w '%{http_code}' "${CANDIDATE_URL}/api/analytics/report")
public_metrics_status=$(sudo curl -sS -o /dev/null -w '%{http_code}' "${CANDIDATE_URL}/metrics/")
[ "$public_report_status" = 404 ] && [ "$public_metrics_status" = 404 ]

podman_cmd restart "$CANDIDATE_API" >/dev/null
wait_for_api "$CANDIDATE_API"
sudo curl -fsS "${CANDIDATE_URL}/api/community/poll" | sudo grep -Fq "$feature_title"
sudo curl -fsS "${CANDIDATE_METRICS_URL}/api/analytics/report?days=30" | sudo grep -Eq '"page_view":[1-9][0-9]*'

echo "Candidates passed. Switching the loopback origin with automatic rollback protection."
CUTOVER_STARTED=true
stop_current_stack
create_stack \
  "$POD_NAME" "$API_CONTAINER" "$SITE_CONTAINER" \
  "127.0.0.1:${PORT}:8080" "0.0.0.0:${METRICS_PORT}:8082" "$COMMUNITY_DATA_DIR" \
  "$API_CANDIDATE_IMAGE" "$SITE_CANDIDATE_IMAGE"
install_generated_units
podman_cmd pod stop "$POD_NAME" >/dev/null
sudo systemctl start "$POD_SERVICE"
verify_live_stack
install_metrics_timer
sudo systemctl start tabmonger-metrics-report.service
sudo test -s "${DATA_ROOT}/analytics-reports/latest.md"

podman_cmd tag "$SITE_CANDIDATE_IMAGE" "$SITE_IMAGE_NAME"
podman_cmd tag "$API_CANDIDATE_IMAGE" "$API_IMAGE_NAME"
CUTOVER_STARTED=false
trap - ERR

podman_cmd pod ps --filter name="$POD_NAME"
podman_cmd ps --filter pod="$POD_NAME"
printf '\nTabMonger website: http://127.0.0.1:%s\n' "$PORT"
printf 'Private metrics: http://<server-lan-address>:%s/metrics/\n' "$METRICS_PORT"
printf 'Moderation: sudo podman exec %s node moderate.mjs list --status pending\n' "$API_CONTAINER"
if [ "$ROLLBACK_AVAILABLE" = true ]; then
  printf 'Rollback images preserved for deploy %s.\n' "$DEPLOY_ID"
fi
