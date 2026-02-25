#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${WORKER_BASE_URL:-}" ]]; then
  echo "[ERROR] WORKER_BASE_URL is required"
  echo "example: WORKER_BASE_URL=https://voc-radar-api.<subdomain>.workers.dev"
  exit 1
fi

APP_ID="${APP_ID:-1018769995}"
COUNTRY="${COUNTRY:-kr}"

echo "[1/4] health"
curl -fsS "${WORKER_BASE_URL}/api/health" | head -c 200; echo

echo "[2/4] public overview"
curl -fsS "${WORKER_BASE_URL}/api/public/overview?appId=${APP_ID}&country=${COUNTRY}" | head -c 300; echo

echo "[3/4] public trends"
curl -fsS "${WORKER_BASE_URL}/api/public/trends?appId=${APP_ID}&country=${COUNTRY}" | head -c 300; echo

echo "[4/4] public categories"
curl -fsS "${WORKER_BASE_URL}/api/public/categories?appId=${APP_ID}&country=${COUNTRY}" | head -c 300; echo

echo "[OK] public smoke checks passed"
