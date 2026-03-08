#!/usr/bin/env bash
set -euo pipefail

# Public API smoke test:
# - Worker가 공개 읽기 API를 정상 응답하는지 빠르게 확인한다.
# - 공개 저장소 기준으로 APP_ID는 직접 넘기는 방식을 기본으로 한다.

if [[ -z "${WORKER_BASE_URL:-}" ]]; then
  echo "[ERROR] WORKER_BASE_URL is required"
  echo "example: WORKER_BASE_URL=https://<your-worker-domain>"
  exit 1
fi

if [[ -z "${APP_ID:-}" ]]; then
  echo "[ERROR] APP_ID is required"
  exit 1
fi

COUNTRY="${COUNTRY:-kr}"

echo "[1/7] health"
curl -fsS "${WORKER_BASE_URL}/api/health" | head -c 200; echo

echo "[2/7] public overview"
curl -fsS "${WORKER_BASE_URL}/api/public/overview?appId=${APP_ID}&country=${COUNTRY}" | head -c 300; echo

echo "[3/7] public trends"
curl -fsS "${WORKER_BASE_URL}/api/public/trends?appId=${APP_ID}&country=${COUNTRY}" | head -c 300; echo

echo "[4/7] public categories"
curl -fsS "${WORKER_BASE_URL}/api/public/categories?appId=${APP_ID}&country=${COUNTRY}" | head -c 300; echo

echo "[5/7] public dashboard"
curl -fsS "${WORKER_BASE_URL}/api/public/dashboard?appId=${APP_ID}&country=${COUNTRY}" | head -c 400; echo

echo "[6/7] public issues"
curl -fsS "${WORKER_BASE_URL}/api/public/issues?appId=${APP_ID}&country=${COUNTRY}&limit=5" | head -c 400; echo

echo "[7/7] public runs"
curl -fsS "${WORKER_BASE_URL}/api/public/runs?appId=${APP_ID}&country=${COUNTRY}&limit=3" | head -c 300; echo

echo "[OK] public smoke checks passed"
