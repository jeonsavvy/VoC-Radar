# VoC-Radar 배포 런북

## 승인 후 배포 순서

각 단계는 별도 승인과 직전 단계 검증 후 진행합니다.

1. Supabase organization 변경이 필요한 경우에만 project transfer를 수행하고 프로젝트 ref·region·핵심 row count·API 응답을 전후 비교합니다.
2. n8n workflow를 일시 중지하고 active job이 0건인지 확인합니다.
3. Supabase migration을 적용합니다.
4. 통합 Worker를 `REPORT_V2_ENABLED=false`로 배포해 n8n 내부 endpoint와 Web 정적 자산을 준비합니다.
5. n8n workflow를 import하고 credential·환경변수를 확인한 뒤 활성화합니다.
6. 검증용 앱·국가 한 쌍을 재분석하고 cluster contract·membership·publish 원자성을 확인합니다.
7. Worker를 `REPORT_V2_ENABLED=true`로 전환하고 public API와 Web deep link를 smoke test합니다.

새 n8n workflow는 `cluster-context`와 `upsert-clusters` 내부 endpoint를 사용하므로 Worker를 먼저 배포합니다. 공개 read path는 migration·workflow·재분석 검증이 끝날 때까지 `REPORT_V2_ENABLED=false`로 유지합니다.

### Queue 안정화 배포

Queue claim/CAS 변경은 운영 n8n을 일시 중지하고 `queued` 또는 `running` 작업이 0건인지 확인한 뒤에만 별도 승인으로 반영합니다.

```sql
select count(*) as active_jobs
from public.pipeline_jobs
where status in ('queued', 'running');
```

반영 순서는 **DB additive migration → Worker → n8n workflow**입니다. Worker와 n8n의 `N8N_PIPELINE_TRIGGER_SECRET`을 먼저 같은 값으로 설정합니다. 값을 안전하게 설정할 수 없으면 webhook trigger를 비활성화하고 1분 polling만 사용합니다. 각 단계에서 동일 claim key 재시도, lease 회수, 취소 후 stale 요청 거부, 기존 공개 snapshot 유지 여부를 확인한 뒤 다음 단계로 진행합니다.

## Custom Domain 병행 전환

공식 주소는 `https://voc-radar.satinode.com`입니다. 기존 `https://voc-radar.jeonsavvy.workers.dev`도 리다이렉트 없이 같은 통합 Worker를 계속 제공하며, `/api/*`는 두 주소 모두 same-origin을 유지합니다. Custom Domain과 `workers_dev = true`는 `apps/worker/wrangler.toml`에서 함께 관리합니다.

배포 전에는 다음 검증을 실행합니다.

```bash
npm run verify
npm run verify:database:runtime
npm run build:web
npx wrangler deploy --config apps/worker/wrangler.toml --dry-run
```

- 새 주소와 기존 workers.dev 주소의 `/`, `/privacy`, `/apps/kr/<appId>/overview`, 정적 자산이 모두 200인지 확인합니다.
- 기존 workers.dev 주소가 새 주소로 리다이렉트되지 않는지 확인합니다.
- 두 주소의 canonical과 `og:url`이 `https://voc-radar.satinode.com/`인지 확인합니다.
- `CORS_ORIGIN`, n8n BFF URL, Worker 이름, KV binding과 DB binding은 변경하지 않습니다.

Supabase Redirect URL에는 `https://voc-radar.satinode.com/**`를 추가하고 기존 workers.dev 패턴은 보존합니다. 장애 시에는 신규 route와 canonical 변경만 되돌리고 Worker, workers.dev, 데이터, 인증 allowlist는 유지합니다.

## 1) Supabase 준비

Organization 변경이 배포 범위에 포함된 경우 [Supabase project transfer 절차](https://supabase.com/docs/guides/platform/project-transfer)의 사전 조건을 확인하고 별도 승인을 받은 뒤 실행합니다. Transfer 직전에는 사용할 수 있는 백업을 확인하고, 직후 아래 항목을 읽기 전용으로 비교합니다.

- 프로젝트 ref와 region이 기존과 동일한지
- Auth user count와 핵심 테이블 row count가 동일한지
- 기존 Worker `/api/health` 및 공개 read API가 정상인지

### 데이터베이스 스키마

신규 프로젝트에서는 SQL Editor에서 `supabase/schema.sql` 전체를 한 번 실행합니다.

기존 환경에는 배포된 DB 변경 이력과 `supabase/migrations/`를 비교한 뒤, 미적용 파일을 파일명 순서대로 모두 적용합니다. 최신 파일 몇 개만 골라 적용하거나 이미 적용한 파일을 다시 실행하지 않습니다.

적용 전 active job 중복이 없는지 확인하고, 실제 적용 대상과 순서를 기록한 뒤 별도 승인을 받아 수행합니다.

```sql
select app_store_id, country, count(*)
from public.pipeline_jobs
where status in ('queued', 'running')
group by app_store_id, country
having count(*) > 1;
```

점검 SQL은 아래와 같습니다.

```sql
select count(*) from public.reviews;
select count(*) from public.review_ai;
select count(*) from public.pipeline_runs;
select count(*) from public.pipeline_jobs;
select count(*) from public.pipeline_review_ai_staging;
select count(*) from public.issue_clusters;
select count(*) from public.issue_cluster_snapshots;
select count(*) from public.issue_cluster_reviews;
```

## 2) 통합 Worker 배포

배포 전 저장소 검증 게이트를 실행합니다.

```bash
npm run verify
npm run verify:database:runtime
```

초기 보호 배포에서는 V2 flag를 명시적으로 비활성화합니다.

```bash
npm run verify:deploy-env
npm run build:web
npx wrangler deploy --config apps/worker/wrangler.toml --var REPORT_V2_ENABLED:false
```

검증된 기본 설정을 그대로 배포할 때는 `npm run deploy:worker`를 사용합니다. 이 명령은 production Web build 변수 검증, Vite build, Worker deploy 순으로 실행합니다. Worker의 `[assets]` 설정은 `apps/web/dist`를 제공하고 `/api/*`만 Worker 코드를 우선 실행합니다. SPA deep link는 `single-page-application` fallback으로 처리합니다.

필수 Web build 환경변수는 아래와 같습니다. 값은 셸 세션이나 승인된 CI secret에서만 주입하며 저장소에 기록하지 않습니다.

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

운영 통합 Worker는 same-origin API를 사용하므로 `VITE_API_BASE_URL`을 설정하지 않습니다.

### Supabase Auth 반환 URL

운영 이메일 인증 링크가 로컬 개발 주소로 돌아가지 않도록 Supabase Dashboard의 **Authentication > URL Configuration**을 아래처럼 유지합니다.

- Site URL: `https://<your-worker-domain>`
- Redirect URLs: `https://<your-worker-domain>/**`

로컬 주소가 필요하면 Redirect URLs에만 추가하고 운영 Site URL은 변경하지 않습니다. Web은 가입 요청 시 현재 origin과 검증된 `returnTo`를 `emailRedirectTo`로 전달합니다. 롤백 시에는 직전 Site URL과 Redirect URLs를 복원합니다.

`apps/worker/wrangler.toml`의 `0 * * * *` cron은 매시간 `apps`와 `pipeline_runs`에 각각 `limit=1` 조회를 보냅니다.

주의 사항은 아래와 같습니다.

- `/api/health`는 Supabase를 직접 조회하지 않으므로 keepalive 경로가 아닙니다.
- scheduled handler와 `Schedule Trigger (Queue Polling)`의 실행 이력을 각각 확인합니다.

필수 환경변수는 아래와 같습니다.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `PIPELINE_WEBHOOK_SECRET`
- `CORS_ORIGIN`

`CACHE_STATE`는 `apps/worker/wrangler.toml`의 KV binding으로 연결합니다. 배포 dry-run과 운영 Worker 설정에서 binding 이름이 모두 확인되어야 합니다.

`CORS_ORIGIN=https://<your-worker-domain>`으로 설정합니다.

선택 환경변수는 아래와 같습니다.

- `DETAIL_VIEW_ENABLED`
- `REPORT_V2_ENABLED`
- `API_TIMEOUT_MS`
- `API_RETRY_COUNT`
- `N8N_PIPELINE_TRIGGER_URL`
- `N8N_PIPELINE_TRIGGER_SECRET`

`N8N_PIPELINE_TRIGGER_URL`로 webhook trigger를 사용할 때 `N8N_PIPELINE_TRIGGER_SECRET`도 반드시 같은 배포에서 설정합니다. 둘 중 하나만 존재하면 trigger를 사용하지 말고 polling 경로만 활성화합니다.

배포 후 헬스체크를 실행합니다.

```bash
curl --fail https://<your-worker-domain>/api/health
```

### V2 flag 전환

Migration·workflow·재분석·공개 API smoke test가 모두 통과할 때만 `REPORT_V2_ENABLED=true`로 전환합니다. 하나라도 실패하면 `false`를 유지합니다.

```bash
npm run verify:deploy-env
npm run build:web
npx wrangler deploy --config apps/worker/wrangler.toml --var REPORT_V2_ENABLED:true
```

전환 후 통합 Worker root, `/apps/<country>/<appId>/issues`, `/privacy`, `/api/health`를 검증합니다.

### Workers Builds 자동 배포

Workers Builds를 사용할 경우 아래 값을 설정합니다.

- Root directory: `/`
- Build command: `npm run verify:deploy-env && npm run build:web`
- Deploy command: `npm run deploy --workspace @voc-radar/worker`
- Production branch: `main`
- Non-production branch builds: disabled
- Build variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

Web build 변수는 Workers Builds에만 주입하고 저장소에는 기록하지 않습니다. `SUPABASE_SERVICE_ROLE_KEY`, `PIPELINE_WEBHOOK_SECRET` 등 runtime secret은 Worker의 **Variables and Secrets**에만 두고 build 변수로 복제하지 않습니다. 배포 후 build의 commit SHA, Worker name, 배포 version, `/api/health`, SPA deep link를 확인합니다. 자동 배포를 중단할 때는 Settings > Builds에서 연결을 해제하고 마지막으로 검증한 Worker version을 재배포합니다.

## 3) n8n 설정

`n8n/compose.yaml`은 n8n image를 정확한 버전으로 고정하고 UI를 loopback(`127.0.0.1:5679`)에만 노출합니다. 아래 명령으로 실제 image와 렌더링된 설정을 확인합니다.

```bash
docker compose --env-file n8n/.env -f n8n/compose.yaml config --images
docker compose --env-file n8n/.env -f n8n/compose.yaml config
```

Compose 설정은 file-permission enforcement, 내장 task runner의 5분 timeout, community package 차단, 압축 해제 한도를 적용합니다. 성공 실행 데이터는 저장하지 않고 오류 실행 데이터는 168시간 후 정리합니다. 업데이트 전에는 workflow export와 `/home/node/.n8n` 볼륨 백업을 만들고, 새 image를 pull한 뒤 원본 볼륨을 새 버전 전용 볼륨으로 복제해 컨테이너만 교체합니다. 실패 시 원본 볼륨과 이전 image digest를 사용하는 rollback 컨테이너를 시작합니다.

로컬 secret은 커밋하지 않고 `n8n/.env.example`을 복사한 `n8n/.env`에 둡니다.

```bash
docker compose --env-file n8n/.env -f n8n/compose.yaml up -d
```

1. `n8n/workflow.supabase-only.json`을 import합니다.
2. LLM credential을 연결합니다.
3. 아래 환경변수를 입력합니다.
4. Workflow를 **Active**로 전환합니다. 이 저장소의 export 파일은 안전한 재import를 위해 `active: false` 상태입니다. Active 전환 전에는 Web에서 queue를 등록해도 webhook trigger와 1분 polling trigger가 실행되지 않아 작업이 `queued`에 머물 수 있습니다.

- `VOC_BFF_BASE_URL=https://<your-worker-domain>`
- `PIPELINE_WEBHOOK_SECRET=<strong-secret>`
- `VOC_FETCH_WINDOW_DAYS=30`
- `VOC_FETCH_MAX_PAGES=120`
- `VOC_LLM_BATCH_LIMIT=50`
- `VOC_CLUSTER_BATCH_LIMIT=30` (10~40, 기본 30)
- `VOC_MODEL_VERSION=<model-version>`
- `VOC_ALERT_MAX_RATING=2`
- `N8N_PIPELINE_TRIGGER_SECRET=<same-secret-as-worker>`

중요 점검 항목은 아래와 같습니다.

- `Basic LLM Chain.executeOnce = false`
- `Cluster Review Issues.executeOnce = false`
- `Validate Cluster Output`이 누락·중복·허위 review ID와 잘못된 enum을 실패 처리하는지 확인
- `Validate Consolidated Clusters`가 모든 후보 ID와 원본 review ID의 정확히 1회 배정을 다시 확인하는지 확인
- `Upsert Clusters to BFF`가 성공한 뒤에만 publish로 연결되는지 확인
- `Webhook Trigger (Queue Event)`가 production webhook URL(`/webhook/voc-radar-queue-trigger`)로 접근 가능한지 확인
- `Schedule Trigger (Queue Polling)`가 workflow Active 상태에서 1분마다 실행되는지 확인
- `PIPELINE_WEBHOOK_SECRET` 값이 Worker의 `PIPELINE_WEBHOOK_SECRET`과 동일한지 확인
- `N8N_PIPELINE_TRIGGER_SECRET`이 누락되거나 일치하지 않는 webhook 요청을 claim 전에 거부하는지 확인
- 내부 HTTP node가 `PIPELINE_WEBHOOK_SECRET`을 환경변수 표현식에서 직접 읽고 실행 item에 `token` 또는 `fetchToken` 필드가 없는지 확인
- 동일 `$execution.id` 재시도가 새 job을 claim하지 않고 같은 job/token을 재사용하는지 확인

파이프라인 변경 후 기존 리뷰를 다시 처리해야 할 때만 운영자가 `pipeline_jobs.source='reanalysis'`로 작업을 등록합니다. 이 source는 저장된 review extraction을 재사용 입력으로 포함시키며, Web의 신규·갱신 요청이나 24시간 cooldown을 우회하는 공개 API로 노출하지 않습니다. 재분석은 시간 경과 비교가 아니므로 snapshot의 `previous_review_count`와 `change_percent`를 비웁니다. 동일 앱·국가의 active job이 없는지 먼저 확인하고, 실패 run은 publish하지 않은 채 원인 수정 후 새 작업으로 재시도합니다.

## 4) 운영 점검

- [ ] `GET /api/health`가 200을 반환하는지 확인합니다.
- [ ] 통합 Worker root와 SPA deep link가 HTML 200을 반환하는지 확인합니다.
- [ ] 첫 화면이 최근 `published_at` 순의 공개 리포트를 표시하는지 확인합니다.
- [ ] `REPORT_V2_ENABLED=false` 상태에서 기존 서비스가 정상인지 확인합니다.
- [ ] migration과 workflow 반영 후 대상 앱을 재분석합니다.
- [ ] `issue_cluster_reviews`에서 동일 run/review 중복이 0건인지 확인합니다.
- [ ] `pipeline_runs.validation_status='passed'`인 run만 published인지 확인합니다.
- [ ] Worker의 `REPORT_V2_ENABLED=true`를 활성화합니다.
- [ ] `GET /api/public/discover`, `GET /api/public/report`, `GET /api/public/issues/:id`가 200을 반환하는지 확인합니다.
- [ ] 비로그인 `GET /api/private/reviews`가 401을 반환하는지 확인합니다.
- [ ] 비로그인 `DELETE /api/private/account`가 401을 반환하는지 확인합니다.
- [ ] 로그인 `GET /api/private/reviews`가 200을 반환하는지 확인합니다.
- [ ] 로그인 `POST /api/private/jobs`가 `fresh | existing | queued`를 반환하는지 확인합니다.
- [ ] 로그인 `POST /api/private/jobs/cancel`가 200을 반환하는지 확인합니다.
- [ ] 계정 탈퇴는 `탈퇴` 입력 전 실행할 수 없고, 성공 시 로그아웃·홈 이동하며, 실패 시 계정과 취소 작업 상태 및 재시도 방법을 표시하는지 확인합니다.
- [ ] 신규 가입 확인 링크가 `https://<your-worker-domain>`으로 돌아오며 세션을 복구하는지 확인합니다.
- [ ] n8n 실행 시 job 상태가 `queued → running → completed/failed`이고 stage가 `fetching → extracting → clustering → publishing` 순서인지 확인합니다.
- [ ] 취소된 job에 대한 이전 실행의 upsert/publish가 `409 job_claim_lost`로 중단되는지 확인합니다.
- [ ] claim lease 만료 작업이 최대 3회까지만 회수되고 이후 `failed`로 종결되는지 확인합니다.
- [ ] active job이 0건일 때 `pipeline_review_ai_staging`도 0건인지 확인합니다.
- [ ] cluster/publish 실패 후 기존 공개 overview·category·trend·review 응답이 유지되는지 확인합니다.
- [ ] publish 후 `pipeline_runs.status='published'`가 반영되는지 확인합니다.
- [ ] parse 오류 시 `parse_errors` 적재를 확인합니다.
- [ ] 오류 응답이 `{ ok:false, error, message, requestId, retryable }` 형태이며 upstream 응답 본문·secret·환경변수명을 포함하지 않는지 확인합니다.

## 5) 롤백

즉시 차단이 필요하면 아래 값을 사용합니다.

- Worker env `DETAIL_VIEW_ENABLED=false`
- Worker env `REPORT_V2_ENABLED=false`

파이프라인 롤백이 필요하면 새 workflow를 비활성화하고 마지막으로 검증한 Worker 버전을 재배포합니다. Queue 안정화 migration의 additive 컬럼, RPC, claim 이력과 신규 cluster 테이블은 삭제하지 않습니다.

데이터 복구가 필요하면 Supabase 백업 또는 PITR 기준으로 복구합니다.
