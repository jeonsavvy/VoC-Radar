# VoC Radar

VoC Radar는 앱 이름, App Store URL 또는 ID로 공개 분석 리포트를 찾고, 반복 이슈를 실제 리뷰 근거와 함께 확인하는 공개 리뷰 인텔리전스 도구입니다. 공개 리포트 열람은 로그인 없이 가능하며 신규 분석과 새로고침 요청만 로그인이 필요합니다.

**공식 주소:** [voc-radar.satinode.com](https://voc-radar.satinode.com)

분석 갱신은 로컬 Docker의 n8n이 실행 중일 때 처리되며, 공개된 리포트는 계속 열람할 수 있습니다.

## 제품 흐름

- `/`: 앱 탐색
- `/apps/:country/:appId/overview`: 기본 공개 리포트
- `/apps/:country/:appId/issues`: 이슈 목록과 근거 리뷰
- `/apps/:country/:appId/reviews`: 공개 리뷰
- `/requests`: 로그인 사용자의 분석 요청 진행 내역

이슈 목록은 클러스터 스냅샷의 canonical `severity`만 사용하며, 신뢰도 퍼센트 대신 정확한 근거 리뷰 수와 비교 가능한 경우의 변화율만 노출합니다.

## 구조

- `apps/web`: React/Vite 공개 탐색·리포트 UI
- `apps/worker`: Web 정적 자산과 `public`/`private`/`internal` API를 제공하며 공통 경계를 `platform` 모듈에 둔 Cloudflare Worker
- `supabase/20260307_voc_radar_bootstrap.sql`: 신규 설치용 최신 스키마
- `supabase/migrations/202607180001_public_intelligence_v2.sql`: V2 additive migration
- `supabase/migrations/202607260001_pipeline_stabilization.sql`: claim lease, CAS, 원자적 pipeline write를 추가하는 additive migration
- `supabase/migrations/202607270001_pipeline_stabilization_runtime_fixes.sql`: pipeline RPC conflict target과 staging FK index를 보정하는 additive migration
- `n8n/workflow.supabase-only.json`: 리뷰 추출 → 클러스터링 → 검증·게시 workflow
- `scripts/cluster-contract.mjs`: 리뷰 ID와 enum을 검증하는 deterministic contract
- `DESIGN.md`: 제품 UI 계약

## 로컬 실행

```bash
npm install
npm run dev:worker
npm run dev:web
```

Worker feature flag는 `apps/worker/wrangler.toml`에서 관리합니다. migration·workflow·공개 API 검증 전에는 `REPORT_V2_ENABLED=false`로 배포하고, 검증을 통과한 뒤 `true`로 전환합니다. 장애 격리나 반대 모드 회귀 검증에서는 두 값을 명시적으로 override합니다.

```bash
REPORT_V2_ENABLED=true
DETAIL_VIEW_ENABLED=true
```

첫 화면은 게시 시각 기준의 최근 공개 리포트를 보여줍니다. 통합 Worker 배포에서는 API가 같은 origin의 `/api`에 있으므로 `VITE_API_BASE_URL`을 설정하지 않습니다.

```bash
# 분리된 로컬 API나 검증 환경에서만 설정
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

## 파이프라인 계약

1. n8n 실행 ID를 `claimKey`로 사용해 작업을 claim합니다. 같은 키의 재시도는 같은 job과 claim token을 반환하며 다른 작업을 가져가지 않습니다.
2. claim lease는 15분이고 최대 시도 횟수는 3회입니다. 만료된 `running` 작업만 회수하며 3회를 소진한 작업은 `failed`로 종결합니다.
3. App Store 리뷰를 수집하고 기존 리뷰와 신규 리뷰를 분리합니다.
4. 신규 리뷰만 모델에 전달해 리뷰별 category·summary를 구조화합니다.
5. 수집 window의 기존 추출 결과와 신규 결과를 합칩니다.
6. 기존 issue cluster context와 매칭하거나 신규 cluster를 생성합니다.
7. Worker가 claim token과 run을 검증하고, 존재하지 않는 review ID, 누락·중복 배정, 잘못된 enum을 차단합니다.
8. review 원문·AI 결과는 run별 비공개 staging에 보관합니다. cluster snapshot·membership 저장은 원자적으로 처리하고, 검증된 run의 review 병합·공개 pointer 갱신·job 완료를 한 transaction으로 publish합니다.

허용되는 job 상태 전이는 `queued → running → completed | failed | canceled`뿐입니다. Terminal 상태는 변경할 수 없고, 취소되거나 claim을 잃은 이전 실행의 후속 요청은 `409 job_claim_lost`로 중단됩니다.

## 검증

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:workflow
npm run verify:database:runtime
```
