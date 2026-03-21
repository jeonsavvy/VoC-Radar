# VoC-Radar 배포 런북

## 1) Supabase 준비

신규 프로젝트라면 SQL Editor에서 아래 파일을 실행해 주시면 됩니다.

```sql
supabase/20260307_voc_radar_bootstrap.sql
```

운영 중인 환경은 `supabase/migrations/` 이력을 유지해 주셔야 합니다.

점검 SQL은 아래와 같습니다.

```sql
select count(*) from public.reviews;
select count(*) from public.review_ai;
select count(*) from public.pipeline_runs;
select count(*) from public.pipeline_jobs;
```

## 2) Worker 배포

루트에서 아래 명령을 사용해 주시면 됩니다.

```bash
npm run deploy:worker
```

이 Worker는 `apps/worker/wrangler.toml`의 cron 설정으로 **1시간마다 Supabase keepalive 조회 2회**를 실행합니다. Supabase Free 플랜의 저활동 자동 pause 경고를 줄이기 위한 용도입니다.

주의 사항은 아래와 같습니다.

- `/api/health`는 Supabase를 직접 조회하지 않으므로 keepalive 경로가 아닙니다.
- 실제 keepalive는 Worker의 scheduled handler가 `apps`, `pipeline_runs`에 각각 `limit=1` 조회를 보내는 방식입니다.
- n8n의 `Schedule Trigger (Queue Polling)`를 함께 활성화하면 추가 완충 장치가 됩니다.

필수 환경변수는 아래와 같습니다.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `PIPELINE_WEBHOOK_SECRET`
- `CORS_ORIGIN`

권장 예시는 아래와 같습니다.

- `CORS_ORIGIN=https://<your-pages-domain>`

비워두면 Worker는 `*`로 응답합니다. 긴급 복구에는 도움이 되지만, 운영 환경에서는 실제 Web 도메인을 명시하는 편이 안전합니다.

선택 환경변수는 아래와 같습니다.

- `N8N_PIPELINE_TRIGGER_URL`
- `N8N_PIPELINE_TRIGGER_SECRET`
- `DETAIL_VIEW_ENABLED`
- `API_TIMEOUT_MS`
- `API_RETRY_COUNT`

헬스체크 예시는 아래와 같습니다.

```bash
curl https://<your-worker-domain>/api/health
```

## 3) Pages 배포

필수 환경변수는 아래와 같습니다.

- `VITE_API_BASE_URL`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

선택 환경변수는 아래와 같습니다.

- `VITE_DEFAULT_APP_ID`
- `VITE_DEFAULT_COUNTRY`
- `VITE_API_TIMEOUT_MS`
- `VITE_API_RETRY_COUNT`

빌드는 아래 명령으로 진행합니다.

```bash
npm run build:web
```

산출물 디렉터리는 아래와 같습니다.

```bash
apps/web/dist
```

## 4) n8n 설정

1. `n8n/workflow.supabase-only.json`을 import합니다.
2. LLM credential을 연결합니다.
3. 아래 환경변수를 입력합니다.

- `VOC_BFF_BASE_URL=https://<your-worker-domain>`
- `PIPELINE_WEBHOOK_SECRET=<strong-secret>`
- `VOC_FETCH_WINDOW_DAYS=30`
- `VOC_FETCH_MAX_PAGES=120`
- `VOC_LLM_BATCH_LIMIT=50`
- `VOC_MODEL_VERSION=<model-version>`
- `VOC_ALERT_MAX_RATING=2`
- `N8N_PIPELINE_TRIGGER_SECRET=<optional-secret>`

중요 점검 항목은 아래와 같습니다.

- `Basic LLM Chain.executeOnce = false`

## 5) 운영 점검

- [ ] `GET /api/health`가 200을 반환하는지 확인합니다.
- [ ] `GET /api/public/dashboard`가 200을 반환하는지 확인합니다.
- [ ] `GET /api/public/runs`가 200을 반환하는지 확인합니다.
- [ ] 비로그인 `GET /api/private/reviews`가 401을 반환하는지 확인합니다.
- [ ] 로그인 `GET /api/private/reviews`가 200을 반환하는지 확인합니다.
- [ ] 로그인 `POST /api/private/jobs`가 201을 반환하는지 확인합니다.
- [ ] 로그인 `POST /api/private/jobs/cancel`가 200을 반환하는지 확인합니다.
- [ ] n8n 실행 시 `queued -> running -> completed/failed` 상태 전이가 보이는지 확인합니다.
- [ ] publish 후 `pipeline_runs.status='published'`가 반영되는지 확인합니다.
- [ ] parse 오류 시 `parse_errors` 적재를 확인합니다.

## 6) 롤백

즉시 차단이 필요하면 아래 값을 사용합니다.

- Worker env `DETAIL_VIEW_ENABLED=false`

파이프라인 롤백이 필요하면 이전 워크플로우 JSON을 다시 import한 뒤 publish합니다.

데이터 복구가 필요하면 Supabase 백업 또는 PITR 기준으로 복구합니다.
