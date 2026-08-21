#!/usr/bin/env bash
set -Eeuo pipefail

DATA_ROOT=${DATA_ROOT:-/opt/apps/data/tabmonger-site}
API_CONTAINER=${API_CONTAINER:-tabmonger-community-api}
REPORT_DIR=${REPORT_DIR:-${DATA_ROOT}/analytics-reports}

install -d -m 0700 "$REPORT_DIR"
temporary=$(mktemp "${REPORT_DIR}/.latest.XXXXXX")
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT

podman exec "$API_CONTAINER" node render-report.mjs 7 > "$temporary"
chmod 0600 "$temporary"
mv -f -- "$temporary" "${REPORT_DIR}/latest.md"
trap - EXIT

