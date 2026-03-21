# VoC-Radar

VoC-Radar는 App Store 리뷰를 수집하고 분류해 공개 대시보드와 리뷰 화면으로 제공하는 프로젝트입니다.

## 제공 기능

- App Store 리뷰 수집 요청 등록
- 기존 `review_id` 기준 중복 제거
- AI 기반 우선순위·유형·요약 분류
- 공개 대시보드 조회
- 공개/비공개 리뷰 조회
- 로그인 사용자 기준 작업 이력 조회 및 취소
- n8n 파이프라인과 Worker 내부 API 연동

## 구조 요약

- `apps/web`: React 기반 프론트엔드입니다.
- `apps/worker`: Cloudflare Worker API입니다.
- `supabase/20260307_voc_radar_bootstrap.sql`: 신규 설치용 최신 스키마입니다.
- `supabase/migrations`: 변경 이력 SQL입니다.
- `n8n/workflow.supabase-only.json`: 운영 워크플로우입니다.
- `docs/architecture.md`: 구조 설명 문서입니다.
- `docs/deployment-runbook.md`: 배포 절차 문서입니다.
- `docs/repository-analysis.md`: 저장소 분석 문서입니다.

## Supabase 자동 pause 방지

Supabase Free 프로젝트는 **7일 이상 매우 낮은 활동**이 이어지면 자동 pause될 수 있습니다. 이 저장소는 이를 줄이기 위해 Worker cron으로 **1시간마다 가벼운 Supabase 읽기 2회**를 실행합니다.

- 구현 위치: `apps/worker/src/index.ts`
- 스케줄 위치: `apps/worker/wrangler.toml`
- keepalive 대상: `apps`, `pipeline_runs` 읽기
- 주의: `/api/health`는 Supabase를 조회하지 않으므로 keepalive 용도가 아닙니다.
- 참고: n8n 워크플로우의 `Schedule Trigger (Queue Polling)`도 활성화되어 있으면 추가 활동원이 됩니다.

## 빠른 시작

### 1) 의존성 설치

```bash
npm install
```

### 2) Supabase 초기 스키마 적용

신규 Supabase 프로젝트라면 아래 파일 하나만 실행해 주시면 됩니다.

```sql
supabase/20260307_voc_radar_bootstrap.sql
```

기존 운영 환경이라면 `supabase/migrations/` 이력을 유지해 주셔야 합니다.

최근 권한/보안 정리 기준에는 아래 migration이 포함됩니다.

```sql
supabase/migrations/202603110001_private_review_feed_security_invoker.sql
```

### 3) Worker 환경변수 준비

`apps/worker/.dev.vars` 또는 Cloudflare Worker 환경변수 예시는 아래와 같습니다.

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

`apps/web/.env.local` 예시는 아래와 같습니다.

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

`.env.example`와 `docs/deployment-runbook.md`를 기준으로 설정해 주시면 됩니다.

| 변수 | 설명 |
| --- | --- |
| `VOC_BFF_BASE_URL` | Worker URL입니다. |
| `PIPELINE_WEBHOOK_SECRET` | 내부 API 인증 토큰입니다. |
| `VOC_FETCH_WINDOW_DAYS` | 리뷰 수집 기간입니다. |
| `VOC_FETCH_MAX_PAGES` | 최대 수집 페이지 수입니다. |
| `VOC_LLM_BATCH_LIMIT` | 한 번에 처리할 AI 분석 수입니다. |
| `VOC_MODEL_VERSION` | 분석 모델 버전 라벨입니다. |
| `VOC_ALERT_MAX_RATING` | 알림 기준 평점 상한입니다. |
| `N8N_PIPELINE_TRIGGER_SECRET` | 선택적 webhook 검증값입니다. |

### 6) 로컬 실행

```bash
# 터미널 1
npm run dev:worker

# 터미널 2
npm run dev:web
```

## API 개요

운영 Worker에서 `CORS_ORIGIN`을 비워두면 `*` fallback이 적용됩니다. 빠른 복구에는 유용하지만, 운영 배포에서는 실제 Web 도메인을 명시해 두는 편이 안전합니다.

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

1. Web에서 수집 요청을 생성합니다.
2. Worker가 queue에 작업을 저장합니다.
3. n8n이 queue를 claim합니다.
4. n8n이 App Store RSS에서 최근 리뷰를 수집합니다.
5. Worker가 기존 `review_id`를 기준으로 신규 리뷰만 남깁니다.
6. AI가 리뷰를 우선순위·유형·요약으로 분류합니다.
7. Worker가 `reviews`, `review_ai`, `pipeline_runs`를 갱신합니다.
8. publish 단계에서 공개 캐시 버전을 갱신합니다.
9. Web이 공개/비공개 API를 호출해 결과를 보여드립니다. 비공개 리뷰 상세는 Worker가 access token을 검증한 뒤 서버 권한으로 조회합니다.

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
