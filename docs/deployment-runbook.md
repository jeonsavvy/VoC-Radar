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
3. Auth > Users에서 테스트 계정 1개 생성

검증 SQL:

```sql
select count(*) from public.reviews;
select count(*) from public.review_ai;
select count(*) from public.pipeline_runs;
```

---

## 2) Worker 배포

`apps/worker` 기준:

```bash
npm run dev:worker
# 또는
cd apps/worker
npx wrangler deploy
```

필수 secret/vars:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `PIPELINE_WEBHOOK_SECRET`
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

빌드 커맨드:

```bash
npm run build --workspace @voc-radar/web
```

Output dir:

```bash
apps/web/dist
```

---

## 4) n8n 전환

1. `workflow.json` import
2. Credential 연결: Gemini / Google Sheets / Telegram
3. ENV 설정:
   - `VOC_BFF_BASE_URL`
   - `PIPELINE_WEBHOOK_SECRET`
   - `VOC_APP_ID`, `VOC_APP_COUNTRY`, `VOC_APP_NAME`
   - `VOC_ALERT_MAX_RATING`
4. Schedule OFF 상태에서 수동 1회 실행
5. 성공 후 Schedule ON

---

## 5) 운영 검증 체크리스트

- [ ] `GET /api/public/overview` 200
- [ ] `GET /api/public/trends` 200
- [ ] `GET /api/public/categories` 200
- [ ] 비로그인 `GET /api/private/reviews` = 401
- [ ] 로그인 `GET /api/private/reviews` = 200
- [ ] n8n 실행 후 `pipeline_runs.status='published'`
- [ ] parse 에러 발생 시 `parse_errors` 적재 확인
- [ ] Telegram 알림 발생 시 `alert_events` 적재 확인

---

## 6) 롤백

### 즉시 차단
- Worker env `DETAIL_VIEW_ENABLED=false`

### 파이프라인 롤백
- n8n에서 `n8n/workflow.v1.json` 재적용

### 데이터 롤백
- Dual-write 기간에는 시트를 운영 기준으로 임시 복귀 가능
