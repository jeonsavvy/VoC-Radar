# VoC-Radar 배포 런북

## 1) Supabase 설정

SQL Editor에서 아래 파일을 순서대로 실행합니다.

1. `supabase/migrations/202602250001_voc_radar_init.sql`
2. `supabase/migrations/202602270001_pipeline_jobs.sql`
3. `supabase/migrations/202602270002_review_prefilter.sql`
4. `supabase/migrations/202603010001_pipeline_jobs_function_fix.sql`
5. `supabase/migrations/202603050002_critical_rule_and_category_normalization.sql`
6. `supabase/migrations/202603050003_category_rebucket_5way.sql`

추가 확인:

- Auth > Users에서 테스트 계정 1개 생성
- Authentication > Email에서 이메일 확인 정책 설정 점검

검증 SQL:

```sql
select count(*) from public.reviews;
select count(*) from public.review_ai;
select count(*) from public.pipeline_runs;
select count(*) from public.pipeline_jobs;
```

---

## 2) Worker 배포

이 저장소는 npm workspace 구조입니다.  
루트에서 `npx wrangler deploy`를 직접 실행하지 말고 아래 명령을 사용합니다.

```bash
npm run deploy:worker
```

필수 환경변수:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `PIPELINE_WEBHOOK_SECRET`
- `CORS_ORIGIN`

운영 권장값:

- `CORS_ORIGIN=https://voc-radar.pages.dev`

선택 환경변수:

- `N8N_PIPELINE_TRIGGER_URL`
- `N8N_PIPELINE_TRIGGER_SECRET`
- `DETAIL_VIEW_ENABLED`

헬스체크:

```bash
curl https://<worker-domain>/api/health
```

---

## 3) Pages 배포

`apps/web` 환경변수:

- `VITE_API_BASE_URL`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_DEFAULT_APP_ID`
- `VITE_DEFAULT_COUNTRY`

운영 권장값:

- `VITE_API_BASE_URL=https://voc-radar-api.jeonsavvy.workers.dev`

빌드:

```bash
npm run build:web
```

Build output directory:

```bash
apps/web/dist
```

주의:

- Pages deploy command에 `wrangler deploy`를 넣지 않습니다.
- Pages는 정적 산출물(`apps/web/dist`)만 배포합니다.

---

## 4) n8n 설정

1. `n8n/workflow.supabase-only.json` import
2. Gemini credential 연결
3. 아래 환경변수 입력

- `VOC_BFF_BASE_URL`
- `PIPELINE_WEBHOOK_SECRET`
- `VOC_FETCH_WINDOW_DAYS=30`
- `VOC_FETCH_MAX_PAGES=120`
- `VOC_LLM_BATCH_LIMIT=50`
- `VOC_MODEL_VERSION`
- `VOC_ALERT_MAX_RATING`
- `N8N_PIPELINE_TRIGGER_SECRET` (선택)

운영 권장값:

- `VOC_BFF_BASE_URL=https://voc-radar-api.jeonsavvy.workers.dev`

4. 워크플로우 Active ON
5. webhook URL 사용 시 Worker의 `N8N_PIPELINE_TRIGGER_URL`에 등록

webhook을 쓰지 않아도, 워크플로우의 1분 폴링 트리거로 큐 처리가 가능합니다.

중요 점검:

- `Basic LLM Chain` 노드의 `executeOnce`가 `false`인지 확인 (true면 첫 배치만 처리됨)

---

## 5) 운영 점검

- [ ] `GET /api/public/overview` 200
- [ ] `GET /api/public/trends` 200
- [ ] `GET /api/public/categories` 200
- [ ] 비로그인 `GET /api/private/reviews` = 401
- [ ] 로그인 `GET /api/private/reviews` = 200
- [ ] 로그인 `POST /api/private/jobs` = 201
- [ ] 로그인 `POST /api/private/jobs/cancel` = 200
- [ ] n8n 실행 시 `queued -> running -> completed/failed` 상태 전이 확인
- [ ] parse 오류 시 `parse_errors` 적재 확인
- [ ] publish 후 `pipeline_runs.status='published'` 확인

---

## 6) 롤백

즉시 차단:

- Worker env `DETAIL_VIEW_ENABLED=false`

파이프라인 롤백:

- 이전 워크플로우 JSON 재import 후 publish

데이터 롤백:

- Supabase 백업/PITR 기준으로 복구
