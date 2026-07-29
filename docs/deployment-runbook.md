# VoC-Radar 배포 런북

## 승인 후 배포 순서

직전 단계가 통과한 경우에만 다음 단계로 진행합니다. 먼저 n8n workflow를 중지하고 active job이 0건인지 확인합니다. Organization 변경이 범위에 있으면 project transfer와 프로젝트 ref·region·핵심 row count·API 응답의 전후 비교도 이 순서 전에 끝냅니다.

1. 사용할 수 있는 backup 또는 PITR 시점을 확인한 뒤 `202607290001_prepare_pipeline_job_enqueue.sql`과 `202607290002_finalize_account_privacy_and_public_apps.sql`을 순서대로 적용합니다. 001은 기존 authenticated insert 경로를 유지한 채 service-role enqueue를 추가합니다. 002는 새 Worker가 사용하는 계정 삭제 준비·공개 앱 목록 RPC를 추가하고 기존 탈퇴 계정의 Web 메모와 사용자에게 보일 수 있는 과거 오류를 안전한 값으로 비가역 정리합니다.
2. service-role INSERT·enqueue·계정 삭제 준비·공개 앱 목록 RPC는 열려 있고 authenticated의 네 RPC 실행은 닫혀 있는지 권한 SQL로 확인합니다.
3. 통합 Worker를 `REPORT_V2_ENABLED=false`로 배포합니다.
4. 로그인 사용자의 신규 queue 양성 smoke를 실행합니다. HTTP 201과 `result='queued'`를 확인하고 생성된 job을 조회한 뒤 취소합니다.
5. `202607290003_harden_pipeline_job_enqueue.sql`을 적용해 authenticated 직접 insert와 INSERT policy를 제거합니다.
6. 최종 권한 상태를 확인하고 같은 신규 queue·조회·취소 smoke를 다시 실행합니다.
7. 아래 migration을 파일명 순서대로 적용합니다.
   - `202607290004_scope_issue_reads_to_requested_window.sql`
   - `202607290005_enforce_pipeline_stage_monotonicity.sql`
   - `202607290006_bound_pipeline_review_scope_lookup.sql`
   - `202607290007_bound_pipeline_cluster_context.sql`
   - `202607290008_bound_pipeline_persistence_inputs.sql`
8. n8n workflow를 import·활성화합니다.
9. 검증용 앱·국가 한 쌍을 `source='reanalysis'`로 재분석해 review scope, cluster context, persistence cap, 최신 membership, publish 원자성을 확인합니다.
10. Worker를 `REPORT_V2_ENABLED=true`로 전환하고 public API와 Web deep link를 smoke test합니다.

새 Worker에는 001의 `enqueue_pipeline_job`과 002의 `prepare_account_deletion`·`get_public_apps` RPC가 모두 필요합니다. 새 n8n workflow에는 006·007·008의 JSONB lookup·persistence 계약과 Worker 내부 endpoint가 필요합니다. 공개 read path는 migration·workflow·재분석 검증이 끝날 때까지 `REPORT_V2_ENABLED=false`로 유지합니다.

`apps/worker/wrangler.toml`의 기본값은 의도적으로 `REPORT_V2_ENABLED=false`입니다. main 연결 빌드와 `npm run deploy:worker`도 검증 전에는 windowed V2 read path를 열지 않습니다. 이 상태의 Worker는 service-role-only latest-run issue RPC를 사용해 기존 리포트와 상세를 계속 제공합니다. `202607290004_scope_issue_reads_to_requested_window.sql`은 이 rollback 경로를 유지하면서 별도 `*_windowed` RPC를 추가합니다. 최종 전환은 아래 V2 flag 명령처럼 명시적으로 `true`를 전달한 배포에서만 수행합니다.

### Queue 안정화 배포

Queue claim/CAS 변경은 운영 n8n을 일시 중지하고 `queued` 또는 `running` 작업이 0건인지 확인한 뒤에만 별도 승인으로 반영합니다.

```sql
select count(*) as active_jobs
from public.pipeline_jobs
where status in ('queued', 'running');
```

반영 순서는 **001–002 expand DB → V2 false Worker → 양성 queue/cancel → 003 harden DB → 양성 queue/cancel → 004–008 DB → n8n workflow → 재분석 → V2 true Worker**입니다. 모든 migration은 파일명 순서대로 migration 이력에 기록합니다. Worker와 n8n의 `N8N_PIPELINE_TRIGGER_SECRET`을 먼저 같은 값으로 설정합니다. 값을 안전하게 설정할 수 없으면 webhook trigger를 비활성화하고 5분 복구 polling만 사용합니다. 각 단계에서 동일 claim key 재시도, lease 회수, 취소 후 stale 요청 거부, 기존 공개 snapshot 유지 여부를 확인한 뒤 다음 단계로 진행합니다.

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

기존 환경에는 배포된 DB 변경 이력과 `supabase/migrations/`를 비교한 뒤 미적용 파일만 적용합니다. raw SQL만 실행해 migration 이력을 건너뛰거나 이미 적용한 파일을 다시 실행하지 않습니다. 이번 staged 전환에서는 migration-aware 실행기로 001–002까지만 적용한 뒤 Worker 양성 smoke 중단점을 두고, 003 harden 뒤 최종 권한 smoke가 통과하면 004–008을 파일명 순서대로 적용합니다. 신규 환경은 001–008을 파일명 순서대로 모두 적용한 뒤 Worker를 배포합니다.

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

### Pipeline job enqueue 권한 전환

이 변경은 임의 순서로 배포하지 않습니다. 다음 순서를 지키고 각 단계의 Worker version과 commit SHA, migration 적용 결과, smoke job id를 운영 기록에 남깁니다.

1. `202607290001_prepare_pipeline_job_enqueue.sql`과 `202607290002_finalize_account_privacy_and_public_apps.sql`을 파일명 순서대로 적용합니다. 이 단계에서는 새 Worker용 service-role RPC와 구 Worker용 authenticated insert가 모두 열려 있어야 합니다.
2. 아래 SQL의 `service_role_insert`, `authenticated_insert`, `service_role_enqueue`가 `true`이고 `authenticated_enqueue`가 `false`인지 확인합니다.
3. 새 Worker를 배포합니다. 승인된 smoke 계정과 최근 완료 run·active job이 없는 앱/국가를 사용해 로그인 `POST /api/private/jobs`가 HTTP 201, `result='queued'`를 반환하는지 확인합니다. `fresh`나 `existing`은 insert 경로를 실행하지 않았으므로 통과가 아닙니다.
4. 반환된 job을 조회해 `requested_by`가 smoke 계정 UUID이고 `status='queued'`, `stage='queued'`, `attempt_count=0`인지 확인한 뒤 취소합니다. 실패하면 여기서 중단하고 이전 Worker로 되돌립니다. Prepare migration은 additive이므로 그대로 둔 채 harden migration을 적용하지 않습니다.
5. 새 Worker version과 positive enqueue 증거를 확인한 뒤에만 `202607290003_harden_pipeline_job_enqueue.sql`을 적용합니다. 이 시점이 구 Worker로의 롤백 금지 경계입니다.
6. 아래 SQL의 `service_role_insert=true`, `authenticated_insert=false`, `service_role_enqueue=true`, `authenticated_enqueue=false`와 INSERT policy 0건을 확인합니다. 같은 smoke를 다시 수행해 최종 권한 상태에서도 신규 queue insert가 성공하는지 확인하고 생성된 job을 취소합니다.
7. 두 번째 smoke까지 통과한 뒤 004–008을 파일명 순서대로 적용합니다. 004는 service-role-only latest-run RPC를 rollback 경로로 유지하면서 windowed RPC를 추가합니다. 005는 동일 stage heartbeat와 이후 stage 전이만 허용합니다. 006·007·008은 새 workflow의 bounded lookup과 persistence 계약을 제공합니다. 002는 이미 새 Worker 배포 전에 적용돼 있어야 합니다.
8. n8n workflow와 재분석 결과를 검증한 뒤에만 `REPORT_V2_ENABLED=true`로 전환합니다.

```sql
select
  has_table_privilege('service_role', 'public.pipeline_jobs', 'INSERT') as service_role_insert,
  has_table_privilege('authenticated', 'public.pipeline_jobs', 'INSERT') as authenticated_insert,
  has_function_privilege(
    'service_role',
    'public.enqueue_pipeline_job(text,text,text,text,uuid,integer)',
    'EXECUTE'
  ) as service_role_enqueue,
  has_function_privilege(
    'authenticated',
    'public.enqueue_pipeline_job(text,text,text,text,uuid,integer)',
    'EXECUTE'
  ) as authenticated_enqueue;

select policyname
from pg_policies
where schemaname = 'public'
  and tablename = 'pipeline_jobs'
  and cmd = 'INSERT';
```

`USER_JOB_DAILY_LIMIT`은 기본 10, 허용 범위 1–100입니다. 새 `source='web'` job을 만들 때 사용자 UUID별 rolling 24시간 quota를 RPC 내부 advisory lock으로 원자적으로 적용합니다. 최근 24시간에 생성된 Web job은 현재 상태가 `completed`, `failed`, `canceled`여도 모두 계산합니다. `fresh`와 이미 존재하는 active job 응답은 새 job을 만들지 않으므로 해당 요청에서 quota를 추가로 소비하지 않습니다. 값을 기존 최근 job 수보다 낮추면 가장 오래된 계산 대상이 24시간 창을 벗어날 때까지 새 요청이 차단될 수 있습니다. 장애 시 1–100 범위의 이전 값으로 되돌려 Worker를 재배포하되 authenticated 직접 insert를 다시 열지 않습니다.

Worker는 요청 본문의 앱 이름을 신뢰하지 않습니다. Apple Lookup의 `entity=software` 결과에서 요청한 숫자 ID와 일치하는 software record만 앱 이름의 권위로 사용합니다. Apple이 정상 응답에서 앱을 찾지 못하면 HTTP 400으로 거부하고, 일시 장애이면 사용자 제공 이름을 저장하지 않은 채 숫자 ID로 enqueue를 진행합니다.

Apple Lookup 직전의 `APPLE_LOOKUP_RATE_LIMITER`는 인증 사용자별로 60초에 10회를 허용합니다. `namespace_id = "1001"`은 Cloudflare account 전체에서 고유해야 하며 다른 Worker와 공유하지 않습니다. 이 limiter는 PoP 단위 단기 남용 방어이므로 rolling 24시간 job quota를 대체하지 않습니다. 거절 시 HTTP 429 `job_request_rate_limited`, binding 누락이나 장애 시 HTTP 503 `job_request_guard_unavailable`을 반환하고 Apple은 호출하지 않습니다. binding을 바꿀 때는 계정의 모든 Worker settings를 읽기 전용으로 확인한 뒤 충돌 없는 양의 정수를 고정합니다.

### Bounded pipeline RPC

006의 `get_pipeline_review_scope`는 공백 없는 고유 review ID 1–10,000개를 입력받아 한 개의 JSONB 배열로 반환합니다. `include_analysis=true`인 재분석 lookup은 저장된 `review_ai`가 있는 행만 반환합니다. Worker는 요청 전후에 claim을 갱신하고 반환 ID·앱·국가가 요청 범위와 정확히 일치하는지 확인합니다. 한 JSONB scalar를 사용하므로 PostgREST row limit이나 긴 query URL에 의존하지 않습니다.

007의 `get_pipeline_cluster_context_v2`는 해당 앱·국가의 `published`이면서 validation을 통과한 전체 이력에서 cluster별 최신 유효 snapshot 한 건을 선택합니다. 다른 앱·국가 run은 join에서 제외하며 결과가 10,000건을 넘으면 실패합니다. n8n은 각 clustering batch마다 이 최대 10,000건에서 review category·한국어/라틴/숫자 토큰 관련도, review count, recency를 사용해 context를 결정합니다. 전체 context가 100건 이하이고 JSON이 49,152 UTF-8 bytes 이내이면 전부 보존하고, 그 외에는 최대 160건과 49,152 bytes를 동시에 지킵니다.

008은 `persist_pipeline_reviews`의 review 수와 `persist_issue_clusters`의 cluster·membership 수를 각각 1–10,000으로 제한합니다. Worker도 DB 호출 전에 같은 상한과 빈 입력을 거부합니다. 두 persistence RPC는 한 번만 최대 60초를 사용하고, n8n은 review 저장을 100초, cluster 저장을 150초까지 기다립니다. 파이프라인의 다른 Supabase 호출은 환경값과 무관하게 한 번만 최대 10초를 사용합니다. Workflow persistence payload는 canonical review 필드만 보내며 원본 객체를 `rawSource`에 다시 복제하지 않습니다.

002의 `prepare_account_deletion`은 사용자별 enqueue advisory lock 안에서 active job을 취소하고 모든 해당 사용자 job의 `note`를 지운 뒤 두 건수를 한 transaction에서 반환합니다. 이후 Auth 사용자 삭제가 `requested_by`를 null로 바꿀 때 trigger가 그 사이 생성된 Web job의 note도 함께 지웁니다. `complete_pipeline_job`은 `review_scope_incomplete`만 안정 failure code로 저장하고 그 외 실패 문구를 고정값으로 줄입니다. `get_public_apps`는 partial covering index로 `published`이면서 review가 있는 앱·국가별 최신 run 하나를 선택해 앱 메타와 정확한 복합 키로 결합하고 최대 100건을 한 RPC로 반환합니다.

리뷰 수집은 기본 30일, 최대 40페이지와 terminal probe 1회로 제한합니다. Apple page 요청은 5초·재시도 0회·manual redirect이며 Worker hard deadline은 270초, n8n HTTP timeout은 300초입니다. empty page, short page, window cutoff만 완전한 수집으로 인정합니다. 40페이지 뒤 probe에 요청 기간 리뷰가 더 있거나 입력 상한에 도달하면 HTTP 422 `review_scope_incomplete`로 종결하고 부분 리뷰는 분석하거나 게시하지 않습니다.

배포 후 service-role-only RPC 권한을 확인합니다.

```sql
select
  has_function_privilege('service_role', 'public.get_pipeline_review_scope(text,text,text[],boolean)', 'EXECUTE') as service_review_scope,
  has_function_privilege('authenticated', 'public.get_pipeline_review_scope(text,text,text[],boolean)', 'EXECUTE') as authenticated_review_scope,
  has_function_privilege('service_role', 'public.get_pipeline_cluster_context_v2(text,text)', 'EXECUTE') as service_cluster_context,
  has_function_privilege('authenticated', 'public.get_pipeline_cluster_context_v2(text,text)', 'EXECUTE') as authenticated_cluster_context,
  has_function_privilege('service_role', 'public.persist_pipeline_reviews(uuid,uuid,text,text,text,text,text,jsonb)', 'EXECUTE') as service_persist_reviews,
  has_function_privilege('authenticated', 'public.persist_pipeline_reviews(uuid,uuid,text,text,text,text,text,jsonb)', 'EXECUTE') as authenticated_persist_reviews,
  has_function_privilege('service_role', 'public.persist_issue_clusters(uuid,uuid,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,jsonb)', 'EXECUTE') as service_persist_clusters,
  has_function_privilege('authenticated', 'public.persist_issue_clusters(uuid,uuid,text,text,text,text,timestamptz,timestamptz,boolean,jsonb,jsonb)', 'EXECUTE') as authenticated_persist_clusters,
  has_function_privilege('service_role', 'public.prepare_account_deletion(uuid)', 'EXECUTE') as service_prepare_delete,
  has_function_privilege('authenticated', 'public.prepare_account_deletion(uuid)', 'EXECUTE') as authenticated_prepare_delete,
  has_function_privilege('service_role', 'public.get_public_apps(integer)', 'EXECUTE') as service_public_apps,
  has_function_privilege('authenticated', 'public.get_public_apps(integer)', 'EXECUTE') as authenticated_public_apps;
```

`service_*`는 모두 `true`, `authenticated_*`는 모두 `false`여야 합니다. 최대 10,000개 review lookup은 실제 데이터가 있는 한 앱·국가를 골라 읽기 전용으로 확인합니다.

```sql
with target as (
  select app_store_id, country
  from public.reviews
  group by app_store_id, country
  order by count(*) desc
  limit 1
), requested as (
  select target.app_store_id, target.country,
    array_agg(review.review_id order by review.reviewed_at desc, review.review_id) as review_ids
  from target
  join lateral (
    select review_id, reviewed_at
    from public.reviews
    where app_store_id = target.app_store_id and country = target.country
    order by reviewed_at desc, review_id
    limit 10000
  ) as review on true
  group by target.app_store_id, target.country
), checked as (
  select cardinality(review_ids) as requested_count,
    public.get_pipeline_review_scope(app_store_id, country, review_ids, false) as payload
  from requested
)
select requested_count,
  jsonb_typeof(payload) as payload_type,
  jsonb_array_length(payload) as returned_count,
  requested_count = jsonb_array_length(payload) as exact_count
from checked;
```

Cluster context는 반환된 cluster 수와 각 cluster의 선택 run을 읽기 전용으로 대조합니다. `payload_type='array'`, `bounded=true`, `duplicate_issue_ids=0`, `wrong_latest_snapshot=0`이어야 합니다.

```sql
with target as (
  select app_store_id, country
  from public.issue_clusters
  group by app_store_id, country
  order by count(*) desc
  limit 1
), ranked as (
  select cluster.id::text as issue_id, snapshot.run_id,
    row_number() over (
      partition by cluster.id
      order by pipeline_run.published_at desc nulls last,
        pipeline_run.updated_at desc, snapshot.created_at desc, snapshot.run_id desc
    ) as recency_rank
  from target
  join public.issue_clusters as cluster
    on cluster.app_store_id = target.app_store_id and cluster.country = target.country
  join public.issue_cluster_snapshots as snapshot on snapshot.cluster_id = cluster.id
  join public.pipeline_runs as pipeline_run
    on pipeline_run.run_id = snapshot.run_id
   and pipeline_run.app_store_id = cluster.app_store_id
   and pipeline_run.country = cluster.country
  where pipeline_run.status = 'published'
    and pipeline_run.validation_status = 'passed'
    and snapshot.validation_status = 'passed'
), context as (
  select public.get_pipeline_cluster_context_v2(app_store_id, country) as payload
  from target
), actual as (
  select item->>'issue_id' as issue_id, item->>'run_id' as run_id
  from context cross join lateral jsonb_array_elements(payload) as item
)
select jsonb_typeof(context.payload) as payload_type,
  jsonb_array_length(context.payload) <= 10000 as bounded,
  (select count(*) - count(distinct issue_id) from actual) as duplicate_issue_ids,
  (select count(*)
   from actual
   left join ranked
     on ranked.issue_id = actual.issue_id
    and ranked.run_id = actual.run_id
    and ranked.recency_rank = 1
   where ranked.issue_id is null) as wrong_latest_snapshot
from context;
```

재분석 실행의 `Prepare Cluster Input` 출력에서 모든 batch의 `existingClusterTotalCount <= 10000`, `existingClusterSelectedCount <= 160`, `existingClusterContextBytes <= 49152`를 확인합니다. DB에서는 해당 run의 `pipeline_runs.review_count`, snapshot 수, membership 수가 각각 10,000 이하이고 입력 review ID가 정확히 한 cluster에 배정됐는지 확인합니다. 상한 초과 실패를 운영 job으로 만들지 말고 `npm run verify:database:runtime`의 격리된 PostgreSQL 검증으로 증명합니다.

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
npx wrangler deploy --config apps/worker/wrangler.toml --keep-vars --var REPORT_V2_ENABLED:false
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
- `USER_JOB_DAILY_LIMIT` (기본 10, 1–100)
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
npx wrangler deploy --config apps/worker/wrangler.toml --keep-vars --var REPORT_V2_ENABLED:true
```

전환 후 통합 Worker root, `/apps/<country>/<appId>/issues`, `/privacy`, `/api/health`를 검증합니다.

`REPORT_V2_ENABLED=false`는 overview·issue read를 service-role-only latest-run compatibility RPC로 유지합니다. `DETAIL_VIEW_ENABLED=false`는 공개 issue detail, 원문을 포함하는 legacy dashboard, 공개 review 목록, 로그인 review 목록을 cache나 DB 조회 전에 HTTP 403으로 닫지만 overview와 issue 목록은 계속 제공합니다. 장애 격리 시 두 flag를 독립적으로 내리고 `/api/health`, overview, issue 목록, 차단 대상의 403을 각각 확인합니다.

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

Compose 설정은 production concurrency를 1로 제한하고 file-permission enforcement, 내장 task runner의 5분 timeout, community package 차단, 압축 해제 한도를 적용합니다. 성공 실행 데이터는 저장하지 않고 오류 실행 데이터는 168시간 후 정리합니다. 업데이트 전에는 workflow export와 `/home/node/.n8n` 볼륨 백업을 만들고, 새 image를 pull한 뒤 원본 볼륨을 새 버전 전용 볼륨으로 복제해 컨테이너만 교체합니다. 실패 시 원본 볼륨과 이전 image digest를 사용하는 rollback 컨테이너를 시작합니다.

로컬 secret은 커밋하지 않고 `n8n/.env.example`을 복사한 `n8n/.env`에 둡니다.

```bash
docker compose --env-file n8n/.env -f n8n/compose.yaml up -d
```

1. `n8n/workflow.supabase-only.json`을 import합니다. 공개 export는 portable workflow ID만 포함하고 instance metadata·실행 데이터·credential binding은 제외하므로 운영 대상 workflow와 credential은 import 후 연결합니다.
2. LLM credential을 연결합니다.
3. 아래 환경변수를 입력합니다.
4. Workflow를 **Active**로 전환합니다. 이 저장소의 export 파일은 안전한 재import를 위해 `active: false` 상태입니다. Active 전환 전에는 Web에서 queue를 등록해도 webhook trigger와 5분 polling trigger가 실행되지 않아 작업이 `queued`에 머물 수 있습니다.

- `VOC_BFF_BASE_URL=https://<your-worker-domain>`
- `PIPELINE_WEBHOOK_SECRET=<strong-secret>`
- `N8N_CONCURRENCY_PRODUCTION_LIMIT=1`
- `VOC_FETCH_WINDOW_DAYS=30`
- `VOC_FETCH_MAX_PAGES=40`
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
- `Fetch Cluster Context`가 007의 JSONB 배열을 최대 10,000건으로 받고, `Prepare Cluster Input`이 각 batch를 최대 160건·49,152 UTF-8 bytes로 제한하는지 확인
- 기존 cluster context가 100건 이하일 때는 49,152 bytes 이내인 경우에만 전부 유지하고, byte budget을 넘으면 관련도 선택으로 전환하는지 확인
- review persistence 입력과 cluster·membership 입력이 각각 1–10,000 범위이며 008의 DB cap과 Worker cap이 모두 적용되는지 확인
- `HTTP Request`의 timeout이 300초이고 Worker의 270초 review fetch hard deadline보다 긴지 확인
- `Upsert Reviews to BFF`와 `Upsert Clusters to BFF`의 HTTP timeout이 각각 100초·150초이고 Worker의 60초 persistence DB timeout보다 긴지 확인
- `Upsert Clusters to BFF`가 성공한 뒤에만 publish로 연결되는지 확인
- `Webhook Trigger (Queue Event)`가 production webhook URL(`/webhook/voc-radar-queue-trigger`)로 접근 가능한지 확인
- `Schedule Trigger (Queue Polling)`가 workflow Active 상태에서 정확히 5분마다 실행되고 legacy `triggerTimes` 설정이 없는지 확인
- `PIPELINE_WEBHOOK_SECRET` 값이 Worker의 `PIPELINE_WEBHOOK_SECRET`과 동일한지 확인
- `N8N_PIPELINE_TRIGGER_SECRET`이 누락되거나 일치하지 않는 webhook 요청을 claim 전에 거부하는지 확인
- 내부 HTTP node가 `PIPELINE_WEBHOOK_SECRET`을 환경변수 표현식에서 직접 읽고 실행 item에 `token` 또는 `fetchToken` 필드가 없는지 확인
- 동일 `$execution.id` 재시도가 새 job을 claim하지 않고 같은 job/token을 재사용하는지 확인

Concurrency 1은 긴 실행 중 다음 production 실행을 n8n 내부 queue에 대기시킵니다. Webhook 전달이 실패해도 5분 polling이 queued job을 회수하므로 정상 실행이 끝난 뒤 다음 poll까지 약 5분의 추가 지연이 생길 수 있습니다. Active 전환 후 webhook 경로와 polling 경로를 각각 한 번씩 검증하고 대기 실행 수가 지속적으로 증가하면 새 queue 유입을 멈춘 뒤 workflow를 비활성화합니다.

파이프라인 변경 후 기존 리뷰를 다시 처리해야 할 때만 운영자가 `pipeline_jobs.source='reanalysis'`로 작업을 등록합니다. 이 source는 저장된 review extraction을 재사용 입력으로 포함시키며, Web의 신규·갱신 요청이나 24시간 cooldown을 우회하는 공개 API로 노출하지 않습니다. 재분석은 시간 경과 비교가 아니므로 snapshot의 `previous_review_count`와 `change_percent`를 비웁니다. 동일 앱·국가의 active job이 없는지 먼저 확인하고, 006 review scope와 007 cluster context 반환 수가 각각 10,000 이하인지 확인합니다. 실패 run은 publish하지 않은 채 원인 수정 후 새 작업으로 재시도합니다.

## 4) 운영 점검

- [ ] `GET /api/health`가 200을 반환하는지 확인합니다.
- [ ] 통합 Worker root와 SPA deep link가 HTML 200을 반환하는지 확인합니다.
- [ ] 첫 화면이 최근 `published_at` 순의 공개 리포트를 표시하는지 확인합니다.
- [ ] `REPORT_V2_ENABLED=false` 상태에서 기존 서비스가 정상인지 확인합니다.
- [ ] 001–002 → V2 false Worker → queue/cancel → 003 → queue/cancel → 004–008 순서와 각 단계 증거를 확인합니다.
- [ ] 002와 006–008의 service-role EXECUTE는 `true`, authenticated EXECUTE는 `false`인지 확인합니다.
- [ ] migration과 workflow 반영 후 대상 앱을 재분석합니다.
- [ ] 재분석의 review scope와 cluster context 총량이 각각 10,000 이하인지 확인합니다.
- [ ] 각 clustering batch의 기존 context가 최대 160건·49,152 bytes인지 확인합니다.
- [ ] `issue_cluster_reviews`에서 동일 run/review 중복이 0건인지 확인합니다.
- [ ] `pipeline_runs.validation_status='passed'`인 run만 published인지 확인합니다.
- [ ] Worker의 `REPORT_V2_ENABLED=true`를 활성화합니다.
- [ ] `GET /api/public/discover`, `GET /api/public/report`, `GET /api/public/issues/:id`가 200을 반환하는지 확인합니다.
- [ ] `GET /api/public/apps?limit=100`이 고유 앱·국가를 최근순으로 최대 100건 반환하고 Worker의 DB 요청은 한 번인지 확인합니다.
- [ ] 비로그인 `GET /api/private/reviews`가 401을 반환하는지 확인합니다.
- [ ] 비로그인 `DELETE /api/private/account`가 401을 반환하는지 확인합니다.
- [ ] 로그인 `GET /api/private/reviews`가 200을 반환하는지 확인합니다.
- [ ] 로그인 `POST /api/private/jobs`가 `fresh | existing | queued`를 반환하는지 확인합니다.
- [ ] 새 Web job이 사용자별 rolling 24시간 quota에 포함되고 `failed`나 `canceled`로 바꿔도 계산에서 빠지지 않는지 확인합니다.
- [ ] quota 초과 시 HTTP 429 `job_daily_limit_reached`이고 job이 생성되지 않는지 확인합니다.
- [ ] 동일 로그인 사용자로 Apple Lookup이 필요한 요청을 10회 허용한 뒤 11번째가 HTTP 429 `job_request_rate_limited`이며 Apple과 enqueue가 호출되지 않는지 확인합니다.
- [ ] `APPLE_LOOKUP_RATE_LIMITER` binding이 없거나 실패하면 HTTP 503 `job_request_guard_unavailable`이고 Apple이 호출되지 않는지 확인합니다.
- [ ] 로그인 `POST /api/private/jobs/cancel`가 200을 반환하는지 확인합니다.
- [ ] 계정 탈퇴 준비가 active job을 취소하고 모든 사용자 job 메모를 지운 뒤 Auth 계정을 삭제하는지 확인합니다. Auth 삭제 결과를 확인하지 못한 응답에서는 로그인 상태 확인과 재시도 방법이 노출되는지 확인합니다.
- [ ] 신규 가입 확인 링크가 `https://<your-worker-domain>`으로 돌아오며 세션을 복구하는지 확인합니다.
- [ ] n8n 실행 시 job 상태가 `queued → running → completed/failed`이고 stage가 `fetching → extracting → clustering → publishing` 순서인지 확인합니다.
- [ ] n8n production concurrency가 1이고 polling trigger가 정확히 5분이며 webhook 누락 queued job을 다음 poll에서 회수하는지 확인합니다.
- [ ] 40페이지 뒤에도 기간 내 리뷰가 남는 fixture가 HTTP 422 `review_scope_incomplete`로 실패하고 새 공개 snapshot을 만들지 않는지 확인합니다.
- [ ] extraction·clustering 각 배치의 모델 응답 뒤 heartbeat가 같은 claim을 갱신하고, `409 job_claim_lost`이면 checkpoint 결과가 validation·upsert로 전달되지 않는지 확인합니다.
- [ ] 취소된 job에 대한 이전 실행의 upsert/publish가 `409 job_claim_lost`로 중단되는지 확인합니다.
- [ ] claim lease 만료 작업이 최대 3회까지만 회수되고 이후 `failed`로 종결되는지 확인합니다.
- [ ] active job이 0건일 때 `pipeline_review_ai_staging`도 0건인지 확인합니다.
- [ ] cluster/publish 실패 후 기존 공개 overview·category·trend·review 응답이 유지되는지 확인합니다.
- [ ] publish 후 `pipeline_runs.status='published'`가 반영되는지 확인합니다.
- [ ] parse 오류 시 `parse_errors` 적재를 확인합니다.
- [ ] `DETAIL_VIEW_ENABLED=false`에서 issue detail, legacy dashboard, 공개·로그인 review 목록이 403이고 overview·issue 목록은 정상인지 확인합니다.
- [ ] 오류 응답이 `{ ok:false, error, message, requestId, retryable }` 형태이며 upstream 응답 본문·secret·환경변수명을 포함하지 않는지 확인합니다.

## 5) 롤백

즉시 차단이 필요하면 아래 값을 사용합니다.

- Worker env `DETAIL_VIEW_ENABLED=false`
- Worker env `REPORT_V2_ENABLED=false`

파이프라인 롤백이 필요하면 새 workflow를 비활성화하고 마지막으로 검증한 Worker 버전을 재배포합니다. 001과 004–008의 additive index·RPC·claim 이력과 신규 cluster 테이블은 삭제하지 않습니다. 002의 RPC·trigger도 보존하며, 이미 정리한 orphan Web 메모와 terminal 오류 원문은 일반 rollback으로 복원하지 않습니다. 원문 복구가 반드시 필요하면 002 적용 전에 확인한 backup 또는 PITR만 사용합니다. 002와 006–008을 아직 지원하지 않는 Worker나 workflow를 다시 활성화하지 않습니다.

Queue enqueue 권한 전환에는 별도 롤백 경계가 있습니다. `202607290003_harden_pipeline_job_enqueue.sql` 적용 전에는 이전 Worker로 되돌릴 수 있고 prepare grant는 유지합니다. Harden 적용 후에는 end-user JWT로 `pipeline_jobs`를 insert하던 Worker로 되돌리지 않으며, service-role enqueue를 지원하는 검증된 Worker version만 재배포합니다. 이 호환 버전이 없으면 harden을 적용하지 않습니다. 일반 롤백으로 authenticated INSERT grant나 `pipeline_jobs_insert_authenticated` policy를 복구하면 원래 권한 취약점이 다시 열리므로 복구하지 않습니다.

Quota 설정만 되돌릴 때는 `USER_JOB_DAILY_LIMIT`을 1–100 범위의 직전 값으로 복원하고 Worker를 재배포합니다. Rolling 24시간 이력은 삭제하지 않습니다. 값 복원 후 신규 queue smoke를 실행하되 quota 우회를 위해 job 상태나 `requested_by`를 수정하지 않습니다.

Apple lookup limiter 배포가 실패하면 직전 Worker version을 복원합니다. 이 rollback은 Supabase 데이터를 바꾸지 않습니다. namespace 충돌이 원인이면 현재 계정의 모든 Worker rate-limit binding을 읽기 전용으로 다시 확인하고, 새 고유 namespace ID로 config와 validator를 함께 바꾼 뒤 dry-run부터 반복합니다.

Issue read 전환은 expand/contract 방식입니다. `202607290004_scope_issue_reads_to_requested_window.sql` 적용 후에도 latest-run RPC는 service-role-only로 남으므로 이전 read path와 `REPORT_V2_ENABLED=false` Worker를 재배포할 수 있습니다. 운영 Worker가 모두 windowed RPC를 사용하고 rollback 보존 기간이 끝나기 전에는 latest-run RPC를 삭제하지 않습니다.

Workflow나 persistence 검증이 실패하면 `REPORT_V2_ENABLED=false`를 유지하고 n8n을 비활성화합니다. 실패한 run은 공개 pointer를 바꾸지 않으므로 기존 published snapshot을 유지합니다. 002와 006–008을 되돌리기 위해 함수 권한을 넓히거나 입력 cap·계정 메모 정리·공개 앱 RPC 제한을 제거하지 않습니다. 원인 수정 후 새 workflow 실행과 재분석으로 검증합니다.

데이터 복구가 필요하면 Supabase 백업 또는 PITR 기준으로 복구합니다.
