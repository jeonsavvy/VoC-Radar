# VoC-Radar

VoC-Radar는 App Store 리뷰를 수집하고 분류해 공개 대시보드와 리뷰 화면으로 제공하는 프로젝트다.

## 제공 기능

- App Store 리뷰 수집 요청 등록
- 기존 `review_id` 기준 중복 제거
- AI 기반 우선순위/유형/요약 분류
- 공개 대시보드 조회
- 공개/비공개 리뷰 조회
- 로그인 사용자 기준 작업 이력 조회 및 취소
- n8n 파이프라인과 Worker 내부 API 연동

## 구조 요약

- `apps/web`: React 기반 프론트엔드
- `apps/worker`: Cloudflare Worker API
- `supabase/20260307_voc_radar_bootstrap.sql`: 신규 설치용 최신 스키마
- `supabase/migrations`: 변경 이력 SQL
- `n8n/workflow.supabase-only.json`: 운영 워크플로우
- `docs/architecture.md`: 구조 설명
- `docs/deployment-runbook.md`: 배포 절차
- `docs/repository-analysis.md`: 저장소 분석 문서

## 빠른 시작

### 1) 의존성 설치

```bash
npm install
```

### 2) Supabase 초기 스키마 적용

신규 Supabase 프로젝트라면 아래 파일 하나만 실행한다.

```sql
supabase/20260307_voc_radar_bootstrap.sql
```

기존 운영 환경이라면 `supabase/migrations/` 이력을 유지한다.

### 3) Worker 환경변수 준비

`apps/worker/.dev.vars` 또는 Cloudflare Worker 환경변수:

```bash
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SUPABASE_ANON_KEY=<anon-key>
PIPELINE_WEBHOOK_SECRET=<strong-secret>
DETAIL_VIEW_ENABLED=true
API_TIMEOUT_MS=10000
API_RETRY_COUNT=2
CORS_ORIGIN=https://<your-pages-domain>
N8N_PIPELINE_TRIGGER_URL=https://<your-n8n-domain>/webhook/voc-radar-queue-trigger
N8N_PIPELINE_TRIGGER_SECRET=<optional-random-secret>
```

### 4) Web 환경변수 준비

`apps/web/.env.local`:

```bash
VITE_API_BASE_URL=https://<your-worker-domain>
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_DEFAULT_APP_ID=1234567890
VITE_DEFAULT_COUNTRY=kr
# optional
# VITE_API_TIMEOUT_MS=10000
# VITE_API_RETRY_COUNT=2
```

### 5) n8n 환경변수 준비

`.env.example`와 `docs/deployment-runbook.md`의 값을 기준으로 설정한다.

주요 값:

| 변수 | 설명 |
| --- | --- |
| `VOC_BFF_BASE_URL` | Worker URL |
| `PIPELINE_WEBHOOK_SECRET` | 내부 API 인증 토큰 |
| `VOC_FETCH_WINDOW_DAYS` | 리뷰 수집 기간 |
| `VOC_FETCH_MAX_PAGES` | 최대 수집 페이지 수 |
| `VOC_LLM_BATCH_LIMIT` | 한 번에 처리할 AI 분석 수 |
| `VOC_MODEL_VERSION` | 분석 모델 버전 라벨 |
| `VOC_ALERT_MAX_RATING` | 알림 기준 평점 상한 |
| `N8N_PIPELINE_TRIGGER_SECRET` | 선택적 webhook 검증값 |

### 6) 로컬 실행

```bash
# 터미널 1
npm run dev:worker

# 터미널 2
npm run dev:web
```

## API 개요

### Public

- `GET /api/health`
- `GET /api/public/apps?limit`
- `GET /api/public/apps/search?q&limit`
- `GET /api/public/app-meta?appId&country`
- `GET /api/public/overview?appId&country&from&to`
- `GET /api/public/trends?appId&country&from&to`
- `GET /api/public/categories?appId&country&from&to`
- `GET /api/public/issues?appId&country&from&to&limit`
- `GET /api/public/dashboard?appId&country&from&to`
- `GET /api/public/reviews?appId&country&page&limit&sortBy&sortDirection&rating&priority&category&search`
- `GET /api/public/runs?appId&country&limit`

### Private

- `GET /api/private/jobs?limit`
- `POST /api/private/jobs`
- `POST /api/private/jobs/cancel`
- `GET /api/private/reviews?...`

### Internal

- `POST /api/internal/pipeline/claim-job`
- `POST /api/internal/pipeline/fetch-reviews`
- `POST /api/internal/pipeline/filter-new-reviews`
- `POST /api/internal/pipeline/job-status`
- `POST /api/internal/pipeline/upsert-reviews`
- `POST /api/internal/pipeline/parse-error`
- `POST /api/internal/pipeline/publish`
- `POST /api/internal/pipeline/alert-events`

## 운영 흐름

1. Web에서 수집 요청을 생성한다.
2. Worker가 queue에 작업을 저장한다.
3. n8n이 queue를 claim한다.
4. n8n이 App Store RSS에서 최근 리뷰를 수집한다.
5. Worker가 기존 `review_id`를 기준으로 신규 리뷰만 남긴다.
6. AI가 리뷰를 우선순위/유형/요약으로 분류한다.
7. Worker가 `reviews`, `review_ai`, `pipeline_runs`를 갱신한다.
8. publish 단계에서 공개 캐시 버전을 갱신한다.
9. Web이 공개/비공개 API를 호출해 결과를 보여준다.

## 검증

```bash
npm run lint
npm run typecheck
npm run build
npm run verify:workflow
```

## 문서

- [아키텍처](./docs/architecture.md)
- [배포 런북](./docs/deployment-runbook.md)
- [저장소 분석](./docs/repository-analysis.md)
- [Supabase 가이드](./supabase/README.md)

## 라이선스

MIT
