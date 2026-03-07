# VoC-Radar

VoC-Radar는 App Store 리뷰를 수집하고, 유형별로 정리해 공개 대시보드와 리뷰 화면으로 보여주는 프로젝트입니다.

## 핵심 기능

- 리뷰 수집: n8n이 주기적으로 작업 큐를 확인하고 리뷰를 수집
- 중복 제거: 기존 `review_id`를 먼저 조회해 신규 리뷰만 분석
- AI 분석: 리뷰를 `priority / category / summary`로 분류
- 저장/조회: Supabase에 적재하고 Worker API로 조회
- 공개 화면:
  - 대시보드
  - 리뷰
- 로그인 필요:
  - 수집 실행
  - 내 실행 이력 관리

## 시스템 구성

- **n8n**: 파이프라인 실행(큐 claim, 수집, 분석, 적재 호출)
- **Cloudflare Worker**: API/BFF, 내부 엔드포인트 검증, 캐시 버전 갱신
- **Supabase**: Auth + DB + RLS + 집계 함수
- **Cloudflare Pages**: 리포트 프론트엔드

## 폴더 구조

- `apps/web`: React 프론트엔드
- `apps/worker`: Cloudflare Worker API
- `n8n/workflow.supabase-only.json`: 운영 워크플로우
- `supabase/bootstrap`: 신규 설치용 단일 SQL
- `supabase/migrations`: 변경 이력 SQL
- `supabase/README.md`: Supabase SQL 사용 가이드
- `docs`: 배포/아키텍처 문서

---

## 빠른 시작

### 1) 의존성 설치

```bash
npm install
```

### 2) Supabase SQL 실행

신규 Supabase 프로젝트면 아래 **1개 파일만** 실행하세요.

```sql
supabase/bootstrap/20260307_voc_radar_bootstrap.sql
```

`supabase/migrations/`는 누적 변경 이력입니다.
운영 DB를 유지 중이면 기존 migration 체인을 함부로 지우거나 전체 재실행하지 마세요.

자세한 설명:

- `supabase/README.md`

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
VITE_API_BASE_URL=https://<your-worker-domain>
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_DEFAULT_APP_ID=1018769995
VITE_DEFAULT_COUNTRY=kr
# optional
# VITE_API_TIMEOUT_MS=10000
# VITE_API_RETRY_COUNT=2
```

### 5) n8n 환경변수

n8n에서 워크플로우 `n8n/workflow.supabase-only.json` import 후 아래 값 설정:

| 변수 | 설명 |
|---|---|
| `VOC_BFF_BASE_URL` | Worker URL (`https://<your-worker-domain>`) |
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
- `GET /api/public/dashboard?appId&country&from&to`
- `GET /api/public/issues?appId&country&from&to&limit`
- `GET /api/public/reviews?appId&country&page&limit&sortBy&sortDirection&rating&priority&category&search`
- `GET /api/public/apps/search?q&limit`
- `GET /api/public/runs?appId&country&limit`

### Private (Auth 필요)

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
