# VoC Radar 배포 런북

이 런북의 명령은 저장소 루트에서 실행합니다. Supabase, Cloudflare, n8n 운영 변경은 대상과 승인을 확인한 뒤에만 수행하고 secret·실제 workflow ID·credential ID·version ID는 tracked 파일이나 배포 로그에 남기지 않습니다.

## 1. 배포 전 게이트

다음 값은 운영 기록에만 보관합니다.

- 배포할 commit SHA
- 대상 Supabase project ref와 region
- 현재 Worker version과 feature flag 값
- secret rotation 직후·코드 배포 직전 Worker version
- canonical n8n workflow ID와 현재 published 상태
- active job 수와 migration ledger

저장소 검증은 운영 데이터를 읽거나 외부 서비스를 변경하지 않습니다.

```bash
npm run verify
node scripts/generate-supabase-schema.mjs --check
npm run verify:database:runtime
npm run build:web
npm exec --workspace apps/worker wrangler -- deploy --dry-run --config wrangler.toml
git diff --check
```

`npm run verify:workflow`은 독립된 `n8n/workflow.template.json`과 `n8n/code/*.js`에서 artifact를 메모리 재생성해 `n8n/workflow.supabase-only.json`과 비교합니다. 생성물이 stale이면 아래 순서로 갱신한 뒤 다시 검증합니다.

```bash
node scripts/build-workflow-v2.mjs
node scripts/build-workflow-v2.mjs --check
```

## 2. Supabase: 새 설치와 업그레이드 분리

### Snapshot 갱신

스키마 변경은 새 migration에만 작성합니다. 적용된 migration이나 생성된 `supabase/schema.sql`을 직접 편집하지 않습니다.

```bash
node scripts/generate-supabase-schema.mjs
node scripts/generate-supabase-schema.mjs --check
npm run verify:database
npm run verify:database:runtime
```

생성기는 빈 PostgreSQL 17에 `supabase/migrations/*.sql`을 파일명 순서로 적용하고 최종 `public` schema-only snapshot을 만듭니다. Runtime verifier는 같은 임시 컨테이너의 격리된 두 DB를 사용합니다.

- `fresh_path`: `supabase/schema.sql`만 적용
- `upgrade_path`: migration 전체를 처음부터 순서대로 적용

두 경로의 function, relation, constraint, index, RLS/policy, grant, view/trigger catalog와 semantic fixture가 모두 같아야 합니다.

### 운영 적용

- 빈 새 프로젝트에는 `supabase/schema.sql`을 한 번 적용하고 migration을 다시 실행하지 않습니다.
- 기존 프로젝트에는 운영 ledger와 비교한 미적용 migration만 순서대로 적용합니다. `schema.sql`로 기존 DB를 덮어쓰지 않습니다.
- 배포 commit에 새 migration이 없으면 production SQL을 변경하지 않습니다. ledger·catalog·권한의 읽기 전용 확인을 DB 배포 결과로 기록합니다.

적용 전에는 active job aggregate만 확인합니다. 사용자 review 원문·AI summary·note·error 원문은 읽지 않습니다.

```sql
select status, count(*) as jobs
from public.pipeline_jobs
where status in ('queued', 'running')
group by status
order by status;
```

active job이 있으면 n8n을 중지하고 정상 종료 또는 승인된 취소를 기다립니다. schema/function 변경 중에 claim·heartbeat·publish가 실행되도록 두지 않습니다.

## 3. Secret과 Worker 배포

### Secret 경계

- `PIPELINE_WEBHOOK_SECRET`: n8n → Worker internal API 인증. n8n HTTP node는 환경변수에서 직접 읽고 workflow item에 넣지 않습니다.
- `N8N_PIPELINE_TRIGGER_SECRET`: Worker → n8n webhook trigger 인증. Worker와 n8n 양쪽에 필수이며 `Validate Trigger Secret`이 claim 전에 검사합니다.

Worker internal 요청은 알려진 POST route를 찾은 뒤 raw body를 한 번 읽고 한 번 인증합니다. 알 수 없는 route는 404, 알려진 route의 인증 실패는 401이어야 합니다.

Secret을 회전하는 배포에서는 n8n service를 먼저 중지합니다. 새 값을 양쪽에 반영한 뒤 기존 코드로 Worker를 한 번 배포·검증하고, 그 **secret rotation 이후·새 코드 이전** version을 rollback 기준으로 기록합니다. 이후 코드 version을 배포합니다. 실제 값은 명령 이력, tracked 문서, workflow export에 남기지 않습니다.

### Worker 배포

현재 운영 변수와 feature flag를 먼저 읽기 전용으로 확인합니다. `--keep-vars`는 dashboard에만 있는 변수와 secret을 보존하지만 `wrangler.toml`에 선언된 값을 이기지는 않습니다. 따라서 배포 wrapper는 확인한 두 feature flag를 반드시 명시적으로 전달합니다.

```powershell
$env:REPORT_V2_ENABLED='<verified-live-true-or-false>'
$env:DETAIL_VIEW_ENABLED='<verified-live-true-or-false>'
npm run verify:deploy-env
npm run build:web
npm run deploy --workspace @voc-radar/worker
```

두 값이 없거나 `true|false`가 아니면 wrapper는 Wrangler를 실행하기 전에 실패합니다. `REPORT_V2_ENABLED`가 이미 검증되어 `true`이면 `true`를 전달합니다. DB·workflow 전환 gate에서 승인한 경우에만 확인값 대신 승인된 목표 값을 전달합니다.

필수 runtime secret·변수는 다음과 같습니다.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `PIPELINE_WEBHOOK_SECRET`
- `N8N_PIPELINE_TRIGGER_URL`
- `N8N_PIPELINE_TRIGGER_SECRET`
- `CORS_ORIGIN=https://<worker-host>`

`CACHE_STATE`와 `APPLE_LOOKUP_RATE_LIMITER` binding, custom domain, `workers_dev`, cron은 dry-run과 배포 후 설정에서 확인합니다. 기존 binding이나 route를 일반 코드 배포 중 새 값으로 바꾸지 않습니다.

## 4. n8n workflow를 중복 없이 갱신

`n8n/workflow.supabase-only.json`은 credential과 instance metadata가 없는 portable 생성 artifact입니다. 운영 credential reference를 tracked JSON에 복사하지 않습니다.

1. 새 queue 유입을 멈추고 persistent n8n service를 중지합니다.
2. 같은 volume을 사용하는 pinned n8n one-off CLI로 canonical workflow를 `<operator-private-path>`에 export합니다. 경로는 저장소 밖이어야 하며 권한을 운영자에게만 제한합니다.
3. private export에서 다음 값만 읽습니다.
   - workflow의 canonical `id`
   - stable node `id`로 매칭한 각 node의 `credentials`
4. 생성 artifact를 복사한 임시 JSON에 위 두 항목만 병합합니다. `name`, graph, connection, settings, `webhookId`, `versionId`, tag, execution data, pin data, private metadata는 export에서 가져오지 않습니다. node ID가 없거나 중복되거나 credential node type이 맞지 않으면 중단합니다.
5. 임시 JSON의 workflow `id`가 `<canonical-workflow-id>`인지 확인합니다. import는 이 ID를 update/overwrite 대상으로 사용해야 하며 새 workflow를 만들려는 preview이면 중단합니다.
6. canonical ID에 덮어쓴 뒤 동일 ID의 workflow가 한 건뿐인지 확인합니다. portable ID나 실제 ID를 tracked 파일에 기록하지 않습니다.
7. pinned n8n version이 지원하는 CLI 또는 UI로 canonical workflow를 publish합니다. webhook과 5분 polling trigger가 모두 published graph에 연결됐는지 확인합니다.
8. persistent service를 시작하고 health를 확인합니다.

```bash
docker compose --env-file n8n/.env -f n8n/compose.yaml config --images
docker compose --env-file n8n/.env -f n8n/compose.yaml up -d
docker compose --env-file n8n/.env -f n8n/compose.yaml ps
curl --fail http://127.0.0.1:5679/healthz
```

전체 `docker compose config`는 환경변수를 실제 값으로 펼쳐 terminal·CI log에 secret을 남길 수 있으므로 실행하지 않습니다. `config --images`, container mount metadata, health처럼 값이 드러나지 않는 표면만 운영 증거로 수집합니다.

Import·publish CLI의 option은 pinned image의 `n8n --help`로 확인합니다. ID를 생략한 import나 “새 workflow 생성” 동작은 사용하지 않습니다. 실제 canonical ID, credential ID, version ID는 placeholder로 치환한 운영 영수증에만 남깁니다.

환경변수는 최소 다음 값을 포함합니다.

- `VOC_BFF_BASE_URL=https://<worker-host>`
- `PIPELINE_WEBHOOK_SECRET=<internal-secret>`
- `N8N_PIPELINE_TRIGGER_SECRET=<trigger-secret>`
- `N8N_CONCURRENCY_PRODUCTION_LIMIT=1`
- `VOC_FETCH_WINDOW_DAYS=30`
- `VOC_FETCH_MAX_PAGES=40`
- `VOC_LLM_BATCH_LIMIT=50`
- `VOC_CLUSTER_BATCH_LIMIT=30`
- `VOC_MODEL_VERSION=<model-name>`

두 secret은 서로 다른 방향의 인증 경계입니다. 값이 일치해야 하는 상대는 각각 Worker의 같은 이름 변수이며, 두 종류의 secret이 서로 같은 값을 가질 필요는 없습니다.

## 5. 파이프라인 복구 의미 확인

n8n node의 `maxTries=3`은 한 execution 안의 transient call retry입니다. SQL의 `attempt_count` 최대 3회와 15분 lease는 execution이 죽거나 claim을 잃었을 때의 job recovery입니다. 두 계층을 하나의 retry count로 합치지 않습니다.

같은 논리적 model batch가 각 execution attempt에서 node retry 세 번까지 진행하고, checkpoint 전에 execution이 끝나 DB가 세 번 회수하는 조건에서는 최대 9회 model call이 발생할 수 있습니다. 이는 조건부 최악의 경우 추론이며 실제 호출 수는 실패 지점과 checkpoint 상태에 따라 달라집니다. Worker의 개별 Apple review page 호출은 retry 0회입니다.

n8n terminal failure가 Worker에 실패 상태를 보내지 못하면 job은 `running`으로 남습니다. 마지막 heartbeat 이후 15분 lease 만료와 다음 5분 poll이 모두 최대로 걸리는 조건에서 recovery가 약 20분 뒤 시작될 수 있습니다. 이 시간은 관측·진단 기준이지 자동 실패 SLA가 아닙니다.

## 6. 운영 진단과 대응

다음 SQL은 user content 없이 aggregate와 job ID/state만 읽습니다.

```sql
-- 상태·stage·시도 횟수별 분포와 가장 오래된 heartbeat/lease
select
  status,
  coalesce(stage, '<terminal>') as stage,
  attempt_count,
  count(*) as jobs,
  min(last_heartbeat_at) as oldest_heartbeat_at,
  min(lease_expires_at) as earliest_lease_expires_at
from public.pipeline_jobs
where status in ('queued', 'running')
group by status, stage, attempt_count
order by status, attempt_count desc, stage;

-- lease가 지났거나 최대 3회 중 두 번째 이상인 실행의 식별자와 상태만 확인
select
  id as job_id,
  app_store_id,
  country,
  status,
  stage,
  attempt_count,
  last_heartbeat_at,
  lease_expires_at,
  updated_at
from public.pipeline_jobs
where status = 'running'
  and (lease_expires_at <= now() or attempt_count >= 2)
order by attempt_count desc, lease_expires_at asc nulls first, id;
```

`attempt_count >= 2`는 최대 3회 계약 안에서 조기 확인하기 위한 운영 표시이며 job을 자동 차단하는 새 한도가 아닙니다.

대응 책임은 다음과 같습니다.

1. n8n 운영자가 service health, published workflow, production concurrency, 최근 execution terminal state, webhook과 poll trigger를 확인합니다.
2. Worker 운영자가 해당 `job_id`의 internal API 401/409/5xx aggregate와 request ID를 확인합니다. request body와 secret은 수집하지 않습니다.
3. DB 운영자가 lease 만료 job이 다음 claim에서 `queued` 또는 세 번째 만료 후 `failed`로 전이되는지 확인합니다.
4. stale/high-attempt가 계속 늘면 새 webhook 유입과 workflow를 중지합니다. 행을 수동으로 `queued`나 `completed`로 바꾸지 말고 claim/recovery SQL이 처리하도록 둡니다.
5. claim recovery 자체가 실패한다면 대상 project와 job ID를 다시 확인한 뒤 별도 승인된 복구 변경으로 처리합니다.

## 7. 배포 후 smoke

- [ ] `GET /api/health`가 200입니다.
- [ ] Worker root, `/privacy`, SPA deep link가 HTML 200입니다.
- [ ] `GET /api/public/report`가 `{ data: { window } }`를 반환하고 `window.from <= window.to`입니다.
- [ ] Web의 issue detail·review 요청이 report의 `data.window`를 사용합니다.
- [ ] artwork가 direct URL → Worker proxy 한 번 → local fallback 순서이며 proxy query 중복이 없습니다.
- [ ] 알 수 없는 internal route는 404, 알려진 route의 잘못된 인증은 401입니다.
- [ ] webhook의 잘못된 `N8N_PIPELINE_TRIGGER_SECRET`은 claim 전에 거부됩니다.
- [ ] n8n은 webhook과 5분 poll에서 같은 canonical workflow만 실행합니다.
- [ ] claim·heartbeat·publish 요청의 stale token은 `409 job_claim_lost`입니다.
- [ ] `pipeline_runs.validation_status='passed'`인 run만 published입니다.
- [ ] publish 실패 시 기존 공개 report가 유지됩니다.
- [ ] `REPORT_V2_ENABLED`와 `DETAIL_VIEW_ENABLED`가 배포 전 확인값 또는 승인된 목표값입니다.
- [ ] `job-status`와 public compatibility route가 rollback smoke에서 예상 응답을 유지합니다.

읽기 전용 smoke만으로 충분하지 않아 queue job이 필요한 경우에는 승인된 계정과 전용 앱 범위를 사용하고, 생성한 job ID와 최종 상태만 운영 기록에 남깁니다. 테스트 review나 공개 snapshot을 만들지 않습니다.

## 8. Rollback

코드 rollback은 secret rotation 이후·새 코드 이전에 검증한 Worker version을 사용합니다. rotation 전의 오래된 Worker version은 현재 n8n secret과 맞지 않으므로 재배포하지 않습니다.

1. 새 queue 유입을 멈추고 n8n workflow를 unpublish/비활성화합니다.
2. 저장소 밖의 operator-private export를 같은 canonical workflow ID에 복원합니다. 새 workflow를 만들지 않고 credential reference는 private export에서만 복원합니다.
3. secret rotation 이후·코드 배포 이전 Worker version을 재배포합니다. 해당 version 배포 명령에는 확인한 현재 feature flag 값을 명시하고, `--keep-vars`로 나머지 live 변수와 secret을 보존합니다.
4. n8n service를 시작하고 health, canonical workflow 1건, webhook/poll, Worker internal auth를 확인합니다.
5. DB의 additive object, migration ledger, claim history, published snapshot은 삭제하지 않습니다.

`REPORT_V2_ENABLED`는 rollback이라고 항상 `false`로 바꾸지 않습니다. 장애가 V2 read path에 있고 false compatibility path가 현재 DB·Worker와 함께 검증된 경우에만 승인된 flag 변경으로 내립니다. 이미 `true`가 정상 live 값이고 장애와 무관하면 그대로 유지합니다. `false`에서는 legacy issue list/detail RPC가 `data.window` 기간을 적용하지 못하므로 이슈 수치의 기간 정합성이 일시적으로 저하됩니다.

`/api/internal/pipeline/job-status`, public compatibility route, latest-run RPC는 live caller 부재와 rollback 보존 기간 종료를 모두 증명하기 전까지 유지합니다. 일반 rollback 과정에서 권한을 넓히거나 authenticated DB write를 복원하지 않습니다.

복구가 끝나면 commit SHA, rollback Worker version, canonical workflow 상태, 실행한 검증, 남은 `running`/high-attempt aggregate를 운영 기록에 남깁니다. 실제 secret, credential reference, instance ID와 version ID는 tracked 문서나 이슈에 복사하지 않습니다.
