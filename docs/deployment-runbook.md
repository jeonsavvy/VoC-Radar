# VoC-Radar 배포 런북

## 1) Supabase 준비

신규 프로젝트라면 SQL Editor에서 아래 파일을 실행한다.

```sql
supabase/20260307_voc_radar_bootstrap.sql
```

운영 중인 환경은 `supabase/migrations/` 이력을 유지한다.

점검 SQL:

```sql
select count(*) from public.reviews;
select count(*) from public.review_ai;
select count(*) from public.pipeline_runs;
select count(*) from public.pipeline_jobs;
```

## 2) Worker 배포

루트에서 아래 명령을 사용한다.

```bash
npm run deploy:worker
```

필수 환경변수:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `PIPELINE_WEBHOOK_SECRET`
- `CORS_ORIGIN`

권장 예시:

- `CORS_ORIGIN=https://<your-pages-domain>`

선택 환경변수:

- `N8N_PIPELINE_TRIGGER_URL`
- `N8N_PIPELINE_TRIGGER_SECRET`
- `DETAIL_VIEW_ENABLED`
- `API_TIMEOUT_MS`
- `API_RETRY_COUNT`

헬스체크:

```bash
curl https://<your-worker-domain>/api/health
```

## 3) Pages 배포

필수 환경변수:

- `VITE_API_BASE_URL`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

선택 환경변수:

- `VITE_DEFAULT_APP_ID`
- `VITE_DEFAULT_COUNTRY`
- `VITE_API_TIMEOUT_MS`
- `VITE_API_RETRY_COUNT`

빌드:

```bash
npm run build:web
```

산출물 디렉터리:

```bash
apps/web/dist
```

## 4) n8n 설정

1. `n8n/workflow.supabase-only.json` import
2. LLM credential 연결
3. 아래 환경변수 입력

- `VOC_BFF_BASE_URL=https://<your-worker-domain>`
- `PIPELINE_WEBHOOK_SECRET=<strong-secret>`
- `VOC_FETCH_WINDOW_DAYS=30`
- `VOC_FETCH_MAX_PAGES=120`
- `VOC_LLM_BATCH_LIMIT=50`
- `VOC_MODEL_VERSION=<model-version>`
- `VOC_ALERT_MAX_RATING=2`
- `N8N_PIPELINE_TRIGGER_SECRET=<optional-secret>`

중요 점검:

- `Basic LLM Chain.executeOnce = false`

## 5) 운영 점검

- [ ] `GET /api/health` 200
- [ ] `GET /api/public/dashboard` 200
- [ ] `GET /api/public/runs` 200
- [ ] 비로그인 `GET /api/private/reviews` = 401
- [ ] 로그인 `GET /api/private/reviews` = 200
- [ ] 로그인 `POST /api/private/jobs` = 201
- [ ] 로그인 `POST /api/private/jobs/cancel` = 200
- [ ] n8n 실행 시 `queued -> running -> completed/failed` 상태 전이 확인
- [ ] publish 후 `pipeline_runs.status='published'` 확인
- [ ] parse 오류 시 `parse_errors` 적재 확인

## 6) 롤백

즉시 차단:

- Worker env `DETAIL_VIEW_ENABLED=false`

파이프라인 롤백:

- 이전 워크플로우 JSON 재import 후 다시 publish

데이터 복구:

- Supabase 백업 또는 PITR 기준으로 복구
