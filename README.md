# VoC-Radar

VoC-Radar는 App Store 리뷰를 수집하고, AI로 분류/요약한 뒤, 공개 리포트와 로그인 기반 상세 화면으로 제공하는 프로젝트입니다.

## 핵심 기능

- 리뷰 수집: n8n이 주기적으로 작업 큐를 확인하고 리뷰를 수집
- 중복 제거: 기존 `review_id`를 먼저 조회해 신규 리뷰만 분석
- AI 분석: 리뷰를 `priority / category / summary`로 분류
- 저장/조회: Supabase에 적재하고 Worker API로 조회
- 권한 분리:
  - 공개 API: 집계 데이터
  - 비공개 API: 로그인 사용자 상세 데이터

## 시스템 구성

- **n8n**: 파이프라인 실행(큐 claim, 수집, 분석, 적재 호출)
- **Cloudflare Worker**: API/BFF, 내부 엔드포인트 검증, 캐시 버전 갱신
- **Supabase**: Auth + DB + RLS + 집계 함수
- **Cloudflare Pages**: 리포트 프론트엔드

## 폴더 구조

- `apps/web`: React 프론트엔드
- `apps/worker`: Cloudflare Worker API
- `n8n/workflow.supabase-only.json`: 운영 워크플로우
- `supabase/migrations`: DB 스키마/함수 SQL
- `docs`: 배포/아키텍처 문서

---

## 빠른 시작

### 1) 의존성 설치

```bash
npm install
```

### 2) Supabase SQL 실행

아래 파일을 순서대로 실행하세요.

1. `supabase/migrations/202602250001_voc_radar_init.sql`
2. `supabase/migrations/202602270001_pipeline_jobs.sql`
3. `supabase/migrations/202602270002_review_prefilter.sql`
4. `supabase/migrations/202603010001_pipeline_jobs_function_fix.sql`
5. `supabase/migrations/202603050002_critical_rule_and_category_normalization.sql`
6. `supabase/migrations/202603050003_category_rebucket_5way.sql`

### 3) Worker 환경변수

`apps/worker/.dev.vars` (로컬) 또는 Cloudflare Worker 환경변수:

```bash
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SUPABASE_ANON_KEY=<anon-key>
PIPELINE_WEBHOOK_SECRET=<strong-secret>
DETAIL_VIEW_ENABLED=true
API_TIMEOUT_MS=10000
API_RETRY_COUNT=2
CORS_ORIGIN=https://voc-radar.pages.dev
N8N_PIPELINE_TRIGGER_URL=https://<your-n8n-domain>/webhook/voc-radar-queue-trigger
N8N_PIPELINE_TRIGGER_SECRET=<optional-random-secret>
```

### 4) Web 환경변수

`apps/web/.env.local`:

```bash
VITE_API_BASE_URL=https://voc-radar-api.jeonsavvy.workers.dev
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_DEFAULT_APP_ID=1018769995
VITE_DEFAULT_COUNTRY=kr
VITE_API_TIMEOUT_MS=10000
VITE_API_RETRY_COUNT=2
```

### 5) n8n 환경변수

n8n에서 워크플로우 `n8n/workflow.supabase-only.json` import 후 아래 값 설정:

| 변수 | 설명 |
|---|---|
| `VOC_BFF_BASE_URL` | Worker URL (운영: `https://voc-radar-api.jeonsavvy.workers.dev`) |
| `PIPELINE_WEBHOOK_SECRET` | 내부 API 인증 토큰(`x-voc-token`) |
| `VOC_FETCH_WINDOW_DAYS` | 리뷰 수집 기간(기본 30일, 최대 90일) |
| `VOC_FETCH_MAX_PAGES` | 수집 페이지 상한(기본 120, 최대 200 / 페이지당 50건) |
| `VOC_LLM_BATCH_LIMIT` | 1회 LLM 분석 수(기본/최대 50) |
| `VOC_MODEL_VERSION` | 모델 버전 라벨 |
| `VOC_ALERT_MAX_RATING` | 알림 기준 평점 상한 |
| `N8N_PIPELINE_TRIGGER_SECRET` | webhook 추가 검증(선택) |

### 6) 로컬 실행

```bash
# 터미널 1
npm run dev:worker

# 터미널 2
npm run dev:web
```

---

## API 요약

### Public

- `GET /api/health`
- `GET /api/public/apps?limit`
- `GET /api/public/app-meta?appId&country`
- `GET /api/public/overview?appId&country&from&to`
- `GET /api/public/trends?appId&country&from&to`
- `GET /api/public/categories?appId&country&from&to`

### Private (Auth 필요)

- `GET /api/private/reviews?appId&country&page&limit&sortBy&sortDirection&rating&priority&category&search`
- `GET /api/private/jobs?limit`
- `POST /api/private/jobs`
- `POST /api/private/jobs/cancel`

### Internal (n8n 전용)

- `POST /api/internal/pipeline/claim-job`
- `POST /api/internal/pipeline/fetch-reviews`
- `POST /api/internal/pipeline/filter-new-reviews`
- `POST /api/internal/pipeline/upsert-reviews`
- `POST /api/internal/pipeline/parse-error`
- `POST /api/internal/pipeline/publish`
- `POST /api/internal/pipeline/alert-events`

---

## 검증 명령

```bash
npm run lint
npm run typecheck
npm run build
```

추가로 n8n 워크플로우 구조 검증:

```bash
npm run verify:workflow
```

## 라이선스

MIT
