#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${WORKER_BASE_URL:-}" ]]; then
  echo "[ERROR] WORKER_BASE_URL is required"
  exit 1
fi

if [[ -z "${ACCESS_TOKEN:-}" ]]; then
  echo "[ERROR] ACCESS_TOKEN is required"
  exit 1
fi

APP_ID="${APP_ID:-1018769995}"
COUNTRY="${COUNTRY:-kr}"

curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "${WORKER_BASE_URL}/api/private/reviews?appId=${APP_ID}&country=${COUNTRY}&limit=5" | head -c 500

echo
echo "[OK] private smoke request passed"
