# VoC Radar

VoC Radar는 앱 이름, App Store URL 또는 ID로 공개 분석 리포트를 찾고, 반복 이슈를 실제 리뷰 근거와 함께 확인하는 공개 리뷰 인텔리전스 도구입니다. 공개 리포트는 로그인 없이 볼 수 있고, 신규 분석과 새로고침 요청에는 로그인이 필요합니다.

n8n이 중지되어도 이미 게시된 리포트는 계속 제공됩니다. 새 분석은 n8n이 다시 실행되어 queue를 claim한 뒤 처리됩니다.

## 제품 경로

- `/`: 앱 탐색
- `/apps/:country/:appId/overview`: 공개 리포트 요약
- `/apps/:country/:appId/issues`: 이슈 목록과 근거 리뷰
- `/apps/:country/:appId/reviews`: 공개 리뷰
- `/requests`: 로그인 사용자의 분석 요청 내역

## 실행 구성요소와 책임

- `apps/web`: React/Vite 공개 탐색·리포트 UI. 성공 응답을 runtime decode하고 Worker가 반환한 조회 기간을 후속 요청에 재사용합니다.
- `apps/worker`: Web 정적 자산과 public/private/internal API를 제공합니다. Apple Lookup·리뷰 페이지·아트워크 I/O, 입력 정규화, persisted priority, payload 제한, internal 인증 경계를 소유합니다.
- `n8n`: webhook·5분 polling trigger, queue claim 명령, extraction·clustering·consolidation 모델 호출의 순차 실행, checkpoint와 heartbeat 흐름을 소유합니다. Apple이나 Supabase를 직접 소유하지 않고 Worker API를 호출합니다.
- `supabase`: job 상태, claim token, 15분 lease, `attempt_count`, stage 단조 전이, 비공개 staging, fencing, 원자적 publish를 SQL transaction으로 보장합니다.

## Canonical source

| 계약 | 수정할 원본 | 생성물 또는 adapter |
| --- | --- | --- |
| cluster enum·길이·입력 상한·대표 review ID·정확히 한 번 배정 | `contracts/cluster-contract.mjs` | `apps/worker/src/cluster-contract.ts`, `scripts/cluster-contract.mjs`, n8n Code-node 주입값 |
| cluster 경계 fixture | `contracts/cluster-contract.fixtures.mjs` | Worker·Node·n8n adapter 검증 |
| workflow graph | `n8n/workflow.template.json` | `n8n/workflow.supabase-only.json` |
| workflow Code node | `n8n/code/*.js` | `n8n/workflow.supabase-only.json`에 pack된 `jsCode` |
| 기존 DB 업그레이드 | `supabase/migrations/*.sql`의 순차 이력 | 운영 migration ledger |
| 새 DB 설치 | migration 전체를 재생하는 `scripts/generate-supabase-schema.mjs` | 생성된 `supabase/schema.sql` |

`n8n/workflow.supabase-only.json`과 `supabase/schema.sql`은 직접 편집하지 않습니다. 각각 아래 명령으로 원본에서 다시 만들고 drift를 확인합니다.

```bash
node scripts/build-workflow-v2.mjs
node scripts/build-workflow-v2.mjs --check
node scripts/generate-supabase-schema.mjs
node scripts/generate-supabase-schema.mjs --check
```

## 로컬 실행

```bash
npm install
npm run dev:worker
npm run dev:web
```

통합 Worker에서는 Web과 API가 같은 origin이므로 `VITE_API_BASE_URL`을 설정하지 않습니다. 분리된 로컬 API나 검증 환경에서만 설정합니다.

```bash
# VITE_API_BASE_URL=https://<worker-host>
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_DEFAULT_COUNTRY=kr
```

운영 Worker 배포는 읽기 전용으로 확인한 현재 `REPORT_V2_ENABLED`와 `DETAIL_VIEW_ENABLED` 값을 환경변수에 명시해야 시작됩니다. 배포 wrapper는 두 값을 CLI override로 전달하고 `--keep-vars`로 나머지 dashboard 변수와 secret을 보존합니다. 설정 파일의 fail-closed 기본값이 운영 flag를 뜻하지는 않습니다.

## API

### Public

- `GET /api/public/discover?q&country&limit`
- `GET /api/public/artwork?appId&country`
- `GET /api/public/report?appId&country&from&to`
- `GET /api/public/issues?appId&country&from&to&limit`
- `GET /api/public/issues/:issueId?from&to`
- `GET /api/public/reviews?appId&country&from&to&limit&cursor&...`
- `GET /api/public/apps?limit`

`/api/public/report`의 canonical 성공 DTO는 `{ data: { window, app, summary, analysis, issues, categories, trends } }`입니다. Web은 `data.window.from`과 `data.window.to`를 issue detail과 review 요청에 그대로 사용하며 별도의 30일 기간을 계산하지 않습니다. 정상 운영값 `REPORT_V2_ENABLED=true`에서는 report·issue·review가 같은 기간을 사용합니다. `false` rollback 호환 모드의 legacy issue RPC는 기간 인자를 지원하지 않으므로 이슈 수치만 기간 정합성이 보장되지 않습니다.

아트워크는 메타데이터의 신뢰된 URL 직접 로드 → canonical Worker proxy `/api/public/artwork` 한 번 → 로컬 fallback 순서입니다. Worker가 Apple upstream retry와 cache key를 소유하므로 Web이 같은 proxy를 다른 query로 반복 호출하지 않습니다.

`/api/public/overview`, `/api/public/trends`, `/api/public/categories`, `/api/public/dashboard`, `/api/public/apps/search`, `/api/public/app-meta`, `/api/public/runs`는 기존 caller와 rollback을 위한 compatibility route입니다. 정적 reachability만으로 제거하지 않으며, live caller가 없고 rollback 보존 기간이 끝났다는 증거가 있을 때 별도 변경으로 퇴역시킵니다.

### Private

- `POST /api/private/jobs` → `fresh | existing | queued`
- `GET /api/private/jobs?limit`
- `POST /api/private/jobs/cancel`
- `GET /api/private/reviews`
- `DELETE /api/private/account`

`POST /api/private/jobs`는 요청 본문의 앱 이름을 신뢰하지 않고 Apple Lookup에서 숫자 ID와 일치하는 `software` record를 앱 이름의 기준으로 사용합니다. 사용자별 rolling 24시간 job quota와 Apple Lookup 직전의 단기 rate limit은 서로 다른 경계입니다.

### Internal

- `POST /api/internal/pipeline/claim-job`
- `POST /api/internal/pipeline/fetch-reviews`
- `POST /api/internal/pipeline/job-status`
- `POST /api/internal/pipeline/heartbeat`
- `POST /api/internal/pipeline/filter-new-reviews`
- `POST /api/internal/pipeline/cluster-context`
- `POST /api/internal/pipeline/upsert-reviews`
- `POST /api/internal/pipeline/upsert-clusters`
- `POST /api/internal/pipeline/parse-error`
- `POST /api/internal/pipeline/publish`
- `POST /api/internal/pipeline/alert-events`

Worker는 먼저 알려진 internal POST route를 찾고, 해당 경계에서 raw body를 한 번 읽어 `PIPELINE_WEBHOOK_SECRET`으로 한 번 인증한 뒤 인증된 context만 handler에 전달합니다. 알 수 없는 route는 404이고 알려진 route의 잘못된 서명은 401입니다. `job-status`는 현재 workflow가 직접 호출하지 않더라도 기존 실행·복구 호환성을 위해 유지하며, live caller와 rollback 역할이 모두 사라진 뒤에만 별도로 제거합니다.

n8n webhook trigger에는 Worker와 n8n 양쪽의 `N8N_PIPELINE_TRIGGER_SECRET`이 필수입니다. n8n의 `Validate Trigger Secret`이 claim 전에 요청을 거부합니다. 이 trigger secret과 Worker internal API의 `PIPELINE_WEBHOOK_SECRET`은 목적이 다른 별도 경계이며, 값을 workflow item이나 tracked file에 넣지 않습니다.

## 파이프라인과 재시도

```text
n8n trigger/poll
  -> Worker claim command
  -> Worker Apple review fetch + normalization
  -> n8n ordered extraction/clustering/consolidation calls
  -> Worker payload/auth boundary
  -> SQL staging + fencing + atomic publish
```

- n8n의 transient call retry는 해당 node의 `retryOnFail`과 `maxTries=3`이 소유합니다.
- SQL 실행 복구는 15분 claim lease와 `attempt_count` 최대 3회가 소유합니다. 만료된 `running` job은 다음 claim에서 회수되고, 세 번째 만료는 `failed`로 종결됩니다.
- 두 계층은 독립적입니다. 각 DB 실행 시도가 같은 논리적 모델 batch의 세 번 호출까지 도달한 뒤 실행 자체가 lease 만료로 세 번 회수되는 조건에서는 최대 9회 호출이 발생할 수 있습니다. 이는 조건부 최악의 경우에 대한 추론이며, 실제 호출 수는 실패 지점과 checkpoint 도달 여부에 따라 달라집니다.
- Worker의 개별 Apple review page 요청은 재시도 0회입니다. n8n의 상위 `fetch-reviews` HTTP node retry나 DB job 회수와 Apple page retry를 같은 값으로 해석하지 않습니다.
- n8n 실행이 terminal error로 끝나면서 `job-status`를 갱신하지 못하면 DB에는 `running`이 남을 수 있습니다. 마지막 heartbeat 뒤 15분 lease 만료와 다음 5분 poll이 모두 최대로 걸리는 조건에서는 회수까지 약 20분이 걸릴 수 있다는 운영상 추론입니다.

허용되는 job 상태는 `queued → running → completed | failed | canceled`, stage는 `queued → fetching → extracting → clustering → publishing`입니다. claim을 잃거나 취소된 이전 실행의 후속 요청은 `409 job_claim_lost`로 중단되며, SQL이 staging·snapshot·membership과 publish pointer를 transaction 경계에서 보호합니다.

## Supabase 설치와 검증

- 새 프로젝트: 생성된 `supabase/schema.sql`만 한 번 적용합니다. 과거 migration을 다시 실행하지 않습니다.
- 기존 프로젝트: 운영 ledger와 비교해 `supabase/migrations/`의 미적용 파일만 순서대로 적용합니다. `schema.sql`로 덮어쓰지 않습니다.

Runtime verifier는 한 임시 PostgreSQL 17 컨테이너 안에 서로 격리된 `fresh_path`와 `upgrade_path` DB를 만들고, catalog 계약과 같은 semantic fixture를 비교합니다.

```bash
npm run verify:database
npm run verify:database:runtime
```

## 전체 검증

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:workflow
npm run verify:database:runtime
```

운영 반영, 안전한 n8n 덮어쓰기, 상태 진단, rollback은 `docs/deployment-runbook.md`를 따릅니다.
