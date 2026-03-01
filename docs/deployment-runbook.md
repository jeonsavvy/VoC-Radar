# VoC-Radar v2 배포 런북

## 0) 역할 분리

### Agent가 이미 완료한 것
- Worker + Web + Supabase migration + n8n v2 워크플로우 코드 반영
- 로컬 lint/typecheck/build 검증

### 사용자(운영자)가 해야 하는 조작
1. Supabase 프로젝트에 SQL migration 적용
2. Cloudflare Worker/Pages 실제 배포 및 환경변수 주입
3. n8n에서 workflow import + credential 연결
4. 운영 검증(실데이터 수집/리포트 반영)

---

## 1) Supabase 적용

1. Supabase SQL Editor 열기
2. `supabase/migrations/202602250001_voc_radar_init.sql` 실행
3. `supabase/migrations/202602270001_pipeline_jobs.sql` 실행
4. `supabase/migrations/202602270002_review_prefilter.sql` 실행
5. `supabase/migrations/202603010001_pipeline_jobs_function_fix.sql` 실행
6. Auth > Users에서 테스트 계정 1개 생성
7. Authentication > Email 설정에서 **Confirm email 활성화** 확인

검증 SQL:

```sql
select count(*) from public.reviews;
select count(*) from public.review_ai;
select count(*) from public.pipeline_runs;
select count(*) from public.pipeline_jobs;
select * from public.get_existing_review_ids('1018769995','kr', array[]::text[]) limit 1;
```

---

## 2) Worker 배포

⚠️ 이 저장소는 npm workspace라서 **repo 루트에서 `npx wrangler deploy`를 직접 실행하면 실패**합니다.

권장:

```bash
npm run deploy:worker
```

또는:

```bash
cd apps/worker
npx wrangler deploy
```

필수 secret/vars:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `PIPELINE_WEBHOOK_SECRET`
- `N8N_PIPELINE_TRIGGER_URL` (예: `https://<n8n-domain>/webhook/voc-radar-queue-trigger`)
- `N8N_PIPELINE_TRIGGER_SECRET` (선택)
- `DETAIL_VIEW_ENABLED` (기본 true)
- `CORS_ORIGIN` (Pages 도메인)

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

> `VITE_DEFAULT_*`는 초기 fallback 값이며, 운영 중 앱 전환은 `/analyze` 화면에서 처리할 수 있습니다.

빌드 커맨드:

```bash
npm run build:web
```

Output dir:

```bash
apps/web/dist
```

주의:
- Pages 프로젝트의 deploy command에 `wrangler deploy`를 넣지 마세요.
- Pages는 build output(`apps/web/dist`)만 배포하면 됩니다.

---

## 4) n8n 전환

1. 워크플로우 선택 후 import
   - 운영본: `n8n/workflow.supabase-only.json` (job queue claim + 최대 500개 리뷰 수집 + webhook 트리거)
2. Credential 연결
   - Gemini
3. ENV 설정:
   - `VOC_BFF_BASE_URL`
   - `PIPELINE_WEBHOOK_SECRET`
   - `VOC_APP_ID`, `VOC_APP_COUNTRY`, `VOC_APP_NAME` (fallback 용)
   - `VOC_ALLOW_FALLBACK` (`false` 권장)
   - `VOC_FETCH_LIMIT` (`500` 권장, 최대 500)
   - `VOC_ALERT_MAX_RATING`
4. workflow를 **Active ON**
5. n8n Webhook URL 확인:
   - `POST https://<n8n-domain>/webhook/voc-radar-queue-trigger`
6. 이 URL을 Worker env `N8N_PIPELINE_TRIGGER_URL`에 입력 후 Worker 재배포

---

## 5) 운영 검증 체크리스트

- [ ] `GET /api/public/overview` 200
- [ ] `GET /api/public/trends` 200
- [ ] `GET /api/public/categories` 200
- [ ] 비로그인 `GET /api/private/reviews` = 401
- [ ] 로그인 `GET /api/private/reviews` = 200
- [ ] 로그인 `POST /api/private/jobs` = 201
- [ ] n8n 실행 시 `pipeline_jobs`가 `queued -> running/completed` 전이
- [ ] 동일 리뷰가 재수집돼도 LLM 호출 건수/이벤트 적재 중복이 발생하지 않음
- [ ] n8n 실행 후 `pipeline_runs.status='published'`
- [ ] parse 에러 발생 시 `parse_errors` 적재 확인
- [ ] Critical 이벤트 발생 시 `alert_events` 적재 확인

---

## 6) 롤백

### 즉시 차단
- Worker env `DETAIL_VIEW_ENABLED=false`

### 파이프라인 롤백
- Git에서 이전 커밋의 워크플로우 JSON으로 되돌린 뒤 재import

### 데이터 롤백
- Supabase PITR/백업 기준으로 복구
