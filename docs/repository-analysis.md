# VoC-Radar 저장소 분석

## 1. 시스템 개요

VoC-Radar는 App Store 리뷰를 수집해 AI 분류 결과와 함께 공개 대시보드로 제공하는 프로젝트입니다.

- Web: 사용자 화면과 로그인 기반 작업 제어를 담당합니다.
- Worker: 공개/비공개/내부 API 진입점을 담당합니다.
- Supabase: Auth, 스키마, 집계 함수, queue 상태 저장을 담당합니다.
- n8n: 리뷰 수집, AI 분석, 내부 API 호출을 담당합니다.

## 2. 런타임 데이터 흐름

1. Web이 수집 요청을 등록합니다.
2. Worker가 `pipeline_jobs`에 queue를 생성합니다.
3. n8n이 작업을 claim합니다.
4. App Store RSS에서 최근 리뷰를 수집합니다.
5. Worker가 기존 `review_id`를 제거합니다.
6. AI가 우선순위, 유형, 요약을 생성합니다.
7. Worker가 `reviews`, `review_ai`, `pipeline_runs`를 갱신합니다.
8. publish 단계에서 Worker가 공개 캐시 버전을 갱신합니다.
9. Web이 public/private API로 결과를 조회합니다.

## 3. 폴더별 책임

- `apps/web`: React 화면, API client, 로그인 처리를 담당합니다.
- `apps/worker`: Cloudflare Worker API, Supabase 연결, 내부 파이프라인 엔드포인트를 담당합니다.
- `supabase`: bootstrap SQL, migration SQL, DB 설명 문서를 포함합니다.
- `n8n`: 운영 워크플로우 JSON을 포함합니다.
- `scripts`: 워크플로우 검증, 공개/비공개 smoke script를 포함합니다.
- `docs`: 구조, 배포, 저장소 분석 문서를 포함합니다.

## 4. 주요 엔트리포인트

### Web
- `apps/web/src/main.tsx`: React 렌더 시작점입니다.
- `apps/web/src/App.tsx`: 라우팅과 인증 상태 공유를 담당합니다.
- `apps/web/src/routes/*`: 페이지 단위 화면입니다.
- `apps/web/src/lib/api.ts`: Worker API client입니다.

### Worker
- `apps/worker/src/index.ts`: 전체 API 라우터와 처리 로직입니다.
- `apps/worker/src/types.ts`: 내부/외부 payload 타입입니다.

### Database
- `supabase/20260307_voc_radar_bootstrap.sql`: 최신 스키마 기준본입니다.
- `supabase/migrations/*`: 변경 이력입니다.

## 5. API 구분

### Public API
- 대시보드 집계
- 앱 메타
- 공개 리뷰 목록
- 최근 실행 이력

### Private API
- 수집 요청 생성
- 내 작업 이력 조회
- 작업 취소
- 비공개 리뷰 조회

### Internal API
- queue claim
- 리뷰 fetch/filter
- upsert
- parse error 기록
- publish
- alert event 기록

## 6. DB 핵심 객체

### 테이블
- `apps`: 앱 메타 캐시입니다.
- `reviews`: 원본 리뷰입니다.
- `review_ai`: AI 분류 결과입니다.
- `pipeline_runs`: 분석 실행 결과입니다.
- `parse_errors`: 파싱 실패 기록입니다.
- `alert_events`: 알림 대상 리뷰 기록입니다.
- `pipeline_jobs`: Web 수집 요청 queue입니다.

### view
- `private_review_feed`: 리뷰 원문과 AI 분류를 합친 상세 조회용 read model view입니다. `security_invoker=true`이며 Worker가 service_role로 조회합니다.

### 함수
- `normalize_review_category`: 표시용 유형 정규화 함수입니다.
- `get_public_overview`: 대시보드 요약 함수입니다.
- `get_public_trends`: 일자별 추이 함수입니다.
- `get_public_categories`: 유형 분포 함수입니다.
- `get_public_issues`: 이슈 요약 함수입니다.
- `get_existing_review_ids`: 신규 리뷰 필터링 함수입니다.
- `claim_pipeline_job`: queue claim 함수입니다.
- `complete_pipeline_job`: queue 상태 갱신 함수입니다.

## 7. 환경변수 지도

### Web
- `VITE_API_BASE_URL`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_DEFAULT_APP_ID`
- `VITE_DEFAULT_COUNTRY`
- `VITE_API_TIMEOUT_MS`
- `VITE_API_RETRY_COUNT`

### Worker
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `PIPELINE_WEBHOOK_SECRET`
- `N8N_PIPELINE_TRIGGER_URL`
- `N8N_PIPELINE_TRIGGER_SECRET`
- `DETAIL_VIEW_ENABLED`
- `API_TIMEOUT_MS`
- `API_RETRY_COUNT`
- `CORS_ORIGIN`

### n8n
- `VOC_BFF_BASE_URL`
- `PIPELINE_WEBHOOK_SECRET`
- `VOC_FETCH_WINDOW_DAYS`
- `VOC_FETCH_MAX_PAGES`
- `VOC_LLM_BATCH_LIMIT`
- `VOC_MODEL_VERSION`
- `VOC_ALERT_MAX_RATING`
- `N8N_PIPELINE_TRIGGER_SECRET`

## 8. 검증 명령

```bash
npm run lint
npm run typecheck
npm run build
npm run verify:workflow
```

## 9. dead file / dead dependency 후보

### 삭제 대상 파일
- `apps/web/src/components/ui/dialog.tsx`
- `apps/web/src/components/ui/dropdown-menu.tsx`
- `apps/web/src/components/ui/separator.tsx`
- `apps/web/src/components/ui/table.tsx`
- `apps/web/src/components/ui/tooltip.tsx`

### 삭제 대상 의존성
- `@radix-ui/react-dialog`
- `@radix-ui/react-dropdown-menu`
- `@radix-ui/react-separator`
- `@radix-ui/react-tooltip`

### 유지 대상
- `supabase/migrations/*`
- `scripts/smoke-private.sh`
- `scripts/smoke-worker.sh`
- `apps/web/components.json`
- public endpoint와 연결된 helper

## 10. 개인화/운영값 일반화 대상

- 특정 개인 도메인
- 특정 Pages/Worker 운영 도메인
- 특정 서비스로 보이는 기본 App ID 예시
- 문서와 스크립트 안의 운영 예시 URL

## 11. 이번 정제 범위

### 포함
- dead UI 파일 삭제
- dead dependency 삭제
- README, docs, 핵심 주석 정비
- 공개 저장소용 비개인화
- 노션 포트폴리오 산출물 작성

### 제외
- 공개 API 삭제
- DB 스키마 변경
- n8n 기능 변경
- 제품 기능 추가
