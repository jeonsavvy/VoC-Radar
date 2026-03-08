#!/usr/bin/env bash
set -euo pipefail

# Private API smoke test:
# - 로그인된 사용자의 리뷰 조회가 가능한지 확인한다.
# - 공개 저장소 기준으로 APP_ID는 직접 넘기는 방식을 기본으로 한다.

if [[ -z "${WORKER_BASE_URL:-}" ]]; then
  echo "[ERROR] WORKER_BASE_URL is required"
  exit 1
fi

if [[ -z "${ACCESS_TOKEN:-}" ]]; then
  echo "[ERROR] ACCESS_TOKEN is required"
  exit 1
fi

if [[ -z "${APP_ID:-}" ]]; then
  echo "[ERROR] APP_ID is required"
  exit 1
fi

COUNTRY="${COUNTRY:-kr}"

curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "${WORKER_BASE_URL}/api/private/reviews?appId=${APP_ID}&country=${COUNTRY}&limit=5" | head -c 500

echo
echo "[OK] private smoke request passed"
