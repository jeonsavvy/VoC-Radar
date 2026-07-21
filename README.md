# VoC Radar

VoC Radar는 앱 이름, App Store URL 또는 ID로 공개 분석 리포트를 찾고, 반복 이슈를 실제 리뷰 근거와 함께 확인하는 공개 리뷰 인텔리전스 도구입니다. 공개 리포트 열람은 로그인 없이 가능하며 신규 분석과 새로고침 요청만 로그인이 필요합니다.

## 제품 흐름

- `/`: 앱 탐색
- `/apps/:country/:appId/issues`: 기본 공개 리포트
- `/apps/:country/:appId/overview`: 요약 지표와 유형·추이
- `/apps/:country/:appId/reviews`: 공개 리뷰
- `/requests`: 로그인 사용자의 분석 요청 진행 내역

이슈 목록은 클러스터 스냅샷의 canonical `severity`만 사용하며, 신뢰도 퍼센트 대신 정확한 근거 리뷰 수와 비교 가능한 경우의 변화율만 노출합니다.

## 구조

- `apps/web`: React/Vite 공개 탐색·리포트 UI
- `apps/worker`: Web 정적 자산과 공개/비공개/내부 API를 함께 제공하는 단일 Cloudflare Worker
- `supabase/20260307_voc_radar_bootstrap.sql`: 신규 설치용 최신 스키마
- `supabase/migrations/202607180001_public_intelligence_v2.sql`: V2 additive migration
- `n8n/workflow.supabase-only.json`: 리뷰 추출 → 클러스터링 → 검증·게시 workflow
- `scripts/cluster-contract.mjs`: 리뷰 ID와 enum을 검증하는 deterministic contract
- `DESIGN.md`: 제품 UI 계약

## 로컬 실행

```bash
npm install
npm run dev:worker
npm run dev:web
```

Worker 로컬/운영 환경에는 기존 Supabase·pipeline secrets와 함께 아래 rollout flag를 둡니다. 현재 V2 rollout은 완료되어 기본값은 `true`이며, 장애 격리나 이전 read path 검증 때만 일시적으로 `false`로 내립니다.

```bash
REPORT_V2_ENABLED=true
DETAIL_VIEW_ENABLED=true
```

Web은 가짜 기본 앱 ID를 사용하지 않습니다. 첫 화면에는 고정 추천 대신 게시 시각 기준의 최근 공개 리포트를 보여줍니다. 운영 배포에서는 API가 같은 Worker의 `/api`에 있으므로 `VITE_API_BASE_URL`을 비워 둡니다.

```bash
# 선택: 분리된 로컬 API나 임시 검증 환경에서만 설정
# VITE_API_BASE_URL=https://<your-worker-domain>
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_DEFAULT_COUNTRY=kr
```

## Canonical API

### Public

- `GET /api/public/discover?q&country&limit`
- `GET /api/public/report?appId&country&from&to`
- `GET /api/public/issues?appId&country&limit`
- `GET /api/public/issues/:issueId`
- `GET /api/public/reviews?appId&country&page&limit&...`

### Private

- `POST /api/private/jobs` → `fresh | existing | queued`
- `GET /api/private/jobs?limit`
- `DELETE /api/private/account`

### Internal

- `POST /api/internal/pipeline/claim-job`
- `POST /api/internal/pipeline/fetch-reviews`
- `POST /api/internal/pipeline/filter-new-reviews`
- `POST /api/internal/pipeline/cluster-context`
- `POST /api/internal/pipeline/upsert-reviews`
- `POST /api/internal/pipeline/upsert-clusters`
- `POST /api/internal/pipeline/parse-error`
- `POST /api/internal/pipeline/publish`

기존 `dashboard/overview/categories/trends/apps/search` read model은 rollout rollback 기간에만 유지합니다. V2 운영 검증 후 별도 migration과 Web/Worker 변경으로 제거하며 영구 이중 경로로 유지하지 않습니다.

## 파이프라인 계약

1. App Store 리뷰를 수집하고 기존 리뷰와 신규 리뷰를 분리합니다.
2. 신규 리뷰만 모델에 전달해 리뷰별 category·summary를 구조화합니다.
3. 현재 수집 window의 기존 추출 결과와 신규 결과를 합칩니다.
4. 기존 issue cluster context와 매칭하거나 신규 cluster를 생성합니다.
5. Worker가 존재하지 않는 review ID, 누락·중복 배정, 잘못된 enum을 차단합니다.
6. `issue_clusters`, `issue_cluster_snapshots`, `issue_cluster_reviews`를 갱신한 뒤 검증 통과 run만 publish합니다.

## 검증

```bash
npm run lint
npm run typecheck
npm run test --workspace @voc-radar/web
npm run test --workspace @voc-radar/worker
npm run build
npm run verify:workflow
```

Supabase project transfer·migration, n8n import/activation, 재분석, 통합 Worker 배포와 기존 Pages 제거 절차 및 롤백은 [배포 런북](./docs/deployment-runbook.md)에 기록합니다.

## 문서

- [아키텍처](./docs/architecture.md)
- [배포 런북](./docs/deployment-runbook.md)
- [Supabase 가이드](./supabase/README.md)

## 라이선스

MIT
