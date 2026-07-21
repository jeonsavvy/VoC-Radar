# VoC-Radar 배포 런북

## 승인 후 rollout 순서

각 단계는 별도 승인과 직전 단계 검증 후 진행합니다.

1. Supabase 원본 프로젝트를 목표 organization으로 transfer하고 프로젝트 ref·region·API 응답이 유지되는지 확인합니다.
2. Supabase V2 migration을 적용합니다.
3. 통합 Worker를 `REPORT_V2_ENABLED=false`로 배포해 n8n 내부 endpoint와 Web 정적 자산을 준비합니다.
4. n8n workflow를 import하고 credential·환경변수를 확인한 뒤 활성화합니다.
5. 당근(`1018769995`)과 승리의 여신: 니케(`1585915174`)를 재분석하고 cluster contract·membership을 검증합니다.
6. Worker `REPORT_V2_ENABLED=true`를 활성화하고 public V2 API와 Web deep link를 smoke test합니다.
7. 기존 Pages의 자동 배포를 중단하고 통합 Worker 롤백 검증이 끝난 뒤 Pages 프로젝트를 제거합니다.

Worker를 공개 flag 비활성 상태로 먼저 배포하는 이유는 새 n8n workflow가 `cluster-context`와 `upsert-clusters` 내부 endpoint를 필요로 하기 때문입니다. 이 단계에서는 기존 public read path가 그대로 유지됩니다.

## 1) Supabase organization transfer와 준비

조직 간 이동은 데이터 복사 대신 Supabase의 project transfer를 사용합니다. 이 방식은 region을 바꾸지 않으며 기존 프로젝트 ref와 API 계약을 유지합니다.

사전 조건은 아래와 같습니다.

- 실행자는 source organization Owner여야 합니다.
- 실행자는 target organization의 Member 이상이어야 합니다.
- active GitHub integration, project-scoped role, log drain이 없어야 합니다.
- target organization의 plan과 Free project limit을 확인합니다.
- paid plan에서 Free plan으로 이동하면 1~2분 중단과 기능 손실 가능성이 있으므로 현재 plan을 먼저 확인합니다.

공식 절차: https://supabase.com/docs/guides/platform/project-transfer

transfer 직전에는 Dashboard backup 또는 plan이 허용하는 백업을 확인하고, 직후 아래 항목을 읽기 전용으로 검증합니다.

- 프로젝트 ref와 region이 기존과 동일한지
- Auth user count와 핵심 테이블 row count가 동일한지
- 기존 Worker `/api/health` 및 공개 read API가 정상인지

### V2 schema

신규 프로젝트라면 SQL Editor에서 아래 파일을 실행해 주시면 됩니다.

```sql
supabase/20260307_voc_radar_bootstrap.sql
```

운영 중인 환경은 `supabase/migrations/` 이력을 유지해 주셔야 합니다.

V2 rollout migration은 아래 파일입니다. 적용 전 active job 중복이 없는지 먼저 확인하고, 실제 적용은 별도 승인을 받은 뒤 수행합니다.

```sql
select app_store_id, country, count(*)
from public.pipeline_jobs
where status in ('queued', 'running')
group by app_store_id, country
having count(*) > 1;
```

```text
supabase/migrations/202607180001_public_intelligence_v2.sql
```

점검 SQL은 아래와 같습니다.

```sql
select count(*) from public.reviews;
select count(*) from public.review_ai;
select count(*) from public.pipeline_runs;
select count(*) from public.pipeline_jobs;
select count(*) from public.issue_clusters;
select count(*) from public.issue_cluster_snapshots;
select count(*) from public.issue_cluster_reviews;
```

## 2) 통합 Worker 배포

루트에서 아래 명령을 사용해 주시면 됩니다.

```bash
npm run deploy:worker
```

이 명령은 production Web build 변수 검증, Vite build, Worker deploy 순으로 실행합니다. Worker의 `[assets]` 설정은 `apps/web/dist`를 제공하고 `/api/*`만 Worker 코드를 우선 실행합니다. SPA deep link는 `single-page-application` fallback으로 처리합니다.

필수 Web build 환경변수는 아래와 같습니다. 값은 셸 세션이나 승인된 CI secret에서만 주입하며 저장소에 기록하지 않습니다.

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

운영 통합 Worker는 same-origin API를 사용하므로 `VITE_API_BASE_URL`을 설정하지 않습니다.

### Supabase Auth 반환 URL

운영 이메일 인증 링크가 로컬 개발 주소로 돌아가지 않도록 Supabase Dashboard의 **Authentication > URL Configuration**을 아래처럼 유지합니다.

- Site URL: `https://voc-radar.jeonsavvy.workers.dev`
- Redirect URLs: `https://voc-radar.jeonsavvy.workers.dev/**`

로컬 주소가 필요하면 Redirect URLs에만 별도로 추가하고 운영 Site URL을 `localhost`로 바꾸지 않습니다. Web도 가입 요청 시 현재 origin과 검증된 `returnTo`를 `emailRedirectTo`로 전달해 잘못된 provider fallback을 방어합니다. 롤백 시에는 직전 Site URL과 Redirect URLs를 복원합니다.

이 Worker는 `apps/worker/wrangler.toml`의 cron 설정으로 **1시간마다 Supabase keepalive 조회 2회**를 실행합니다. Supabase Free 플랜의 저활동 자동 pause 경고를 줄이기 위한 용도입니다.

주의 사항은 아래와 같습니다.

- `/api/health`는 Supabase를 직접 조회하지 않으므로 keepalive 경로가 아닙니다.
- 실제 keepalive는 Worker의 scheduled handler가 `apps`, `pipeline_runs`에 각각 `limit=1` 조회를 보내는 방식입니다.
- n8n의 `Schedule Trigger (Queue Polling)`를 함께 활성화하면 추가 완충 장치가 됩니다.

필수 환경변수는 아래와 같습니다.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `PIPELINE_WEBHOOK_SECRET`
- `CORS_ORIGIN`

권장 예시는 아래와 같습니다.

- `CORS_ORIGIN=https://<your-unified-worker-domain>`

비워두면 Worker는 `*`로 응답합니다. 긴급 복구에는 도움이 되지만, 운영 환경에서는 실제 Web 도메인을 명시하는 편이 안전합니다.

선택 환경변수는 아래와 같습니다.

- `N8N_PIPELINE_TRIGGER_URL`
- `N8N_PIPELINE_TRIGGER_SECRET`
- `DETAIL_VIEW_ENABLED`
- `REPORT_V2_ENABLED` (현재 운영값 `true`; migration, workflow, reanalysis 검증 전이나 롤백 때만 `false`)
- `API_TIMEOUT_MS`
- `API_RETRY_COUNT`

헬스체크 예시는 아래와 같습니다.

```bash
curl https://<your-worker-domain>/api/health
```

### V2 flag 활성화

초기 rollout에서는 `false`로 배포해 migration·workflow·재분석을 먼저 검증합니다. 현재 rollout 완료 후 저장소와 production 기본값은 `true`이며, 긴급 롤백에서만 명시적으로 `false`로 override합니다.

```bash
npm run verify:deploy-env
npm run build:web
npx wrangler deploy --config apps/worker/wrangler.toml --var REPORT_V2_ENABLED:true
```

초기 전환에서는 통합 Worker root, `/apps/kr/1018769995/issues`, `/apps/kr/1585915174/issues`, `/privacy`, `/api/health`를 검증한 뒤에만 Pages를 제거합니다. 현재 운영 Pages 프로젝트는 2026-07-21 제거된 상태입니다.

### GitHub 자동 배포

운영 Worker `voc-radar`는 GitHub 저장소 `jeonsavvy/VoC-Radar`의 `main` 브랜치에 연결합니다. Cloudflare Workers Builds 설정은 아래 값을 사용합니다.

- Root directory: `/`
- Build command: `npm run verify:deploy-env && npm run build:web`
- Deploy command: `npm run deploy --workspace @voc-radar/worker`
- Production branch: `main`
- Non-production branch builds: disabled
- Build variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

Web build 변수는 Workers Builds에만 주입하고 저장소에는 기록하지 않습니다. `SUPABASE_SERVICE_ROLE_KEY`, `PIPELINE_WEBHOOK_SECRET` 등 runtime secret은 기존 Worker의 **Variables and Secrets**에만 유지하며 build 변수로 복제하지 않습니다. Git 연동은 기존 커밋을 소급 빌드하지 않으므로 연결 후 검증된 변경을 `main`에 push해 최초 build를 시작합니다. Git 연동 직후에는 최초 build의 commit SHA, Worker name, 배포 version, `/api/health`, SPA deep link를 확인합니다. 자동 배포를 중단해야 하면 Settings > Builds에서 연결을 해제하고 마지막 정상 Worker version을 다시 배포합니다.

## 3) n8n 설정

운영 이미지는 `latest`가 아니라 검증한 정확한 버전으로 고정합니다. 2026-07-21 기준 운영 검증 버전은 `docker.n8n.io/n8nio/n8n:2.30.8`입니다. `n8n/compose.yaml`은 UI를 loopback(`127.0.0.1:5679`)에만 노출하고, file-permission enforcement, 내장 task runner의 5분 timeout, 검증되지 않은 community package 차단, 보수적인 압축 해제 한도를 명시합니다. 업데이트 전에는 workflow export와 `/home/node/.n8n` 볼륨 백업을 만들고, 새 이미지를 먼저 pull한 뒤 원본 볼륨을 새 버전 전용 볼륨으로 복제해 컨테이너만 교체합니다. 실패 시 원본 볼륨과 이전 image digest를 사용하는 정지된 rollback 컨테이너를 다시 시작합니다.

로컬 secret은 커밋하지 않고 `n8n/.env.example`을 복사한 `n8n/.env`에 둡니다.

```bash
docker compose --env-file n8n/.env -f n8n/compose.yaml config
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
- `N8N_PIPELINE_TRIGGER_SECRET=<optional-secret>`

현재 workflow의 Code node는 모두 JavaScript입니다. 기본 n8n 이미지에서 Python runner 부재 안내가 보여도 이 workflow 실행에는 영향이 없습니다. Python Code node를 추가할 때는 앱 컨테이너에 Python을 임의 설치하지 말고 별도 external task runner를 배포한 뒤 검증합니다.

중요 점검 항목은 아래와 같습니다.

- `Basic LLM Chain.executeOnce = false`
- `Cluster Review Issues.executeOnce = false`
- `Validate Cluster Output`이 누락·중복·허위 review ID와 잘못된 enum을 실패 처리하는지 확인
- `Validate Consolidated Clusters`가 모든 후보 ID와 원본 review ID의 정확히 1회 배정을 다시 확인하는지 확인
- `Upsert Clusters to BFF`가 성공한 뒤에만 publish로 연결되는지 확인
- `Webhook Trigger (Queue Event)`가 production webhook URL(`/webhook/voc-radar-queue-trigger`)로 접근 가능한지 확인
- `Schedule Trigger (Queue Polling)`가 workflow Active 상태에서 1분마다 실행되는지 확인
- `PIPELINE_WEBHOOK_SECRET` 값이 Worker의 `PIPELINE_WEBHOOK_SECRET`과 동일한지 확인
- `N8N_PIPELINE_TRIGGER_SECRET`을 사용하는 경우 Worker와 n8n 양쪽 값이 동일한지 확인

파이프라인 변경 후 기존 리뷰를 다시 처리해야 할 때만 운영자가 `pipeline_jobs.source='reanalysis'`로 작업을 등록합니다. 이 source는 저장된 review extraction을 재사용 입력으로 포함시키며, Web의 신규·갱신 요청이나 24시간 cooldown을 우회하는 공개 API로 노출하지 않습니다. 재분석은 시간 경과 비교가 아니므로 snapshot의 `previous_review_count`와 `change_percent`를 비웁니다. 동일 앱·국가의 active job이 없는지 먼저 확인하고, 실패 run은 publish하지 않은 채 원인 수정 후 새 작업으로 재시도합니다.

## 4) 운영 점검

- [ ] `GET /api/health`가 200을 반환하는지 확인합니다.
- [ ] 통합 Worker root와 SPA deep link가 HTML 200을 반환하는지 확인합니다.
- [ ] 첫 화면의 당근·니케가 고정 추천이 아니라 최근 공개 리포트로 표시되는지 확인합니다.
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
- [ ] 신규 가입 확인 링크가 `voc-radar.jeonsavvy.workers.dev`로 돌아오며 세션을 복구하는지 확인합니다.
- [ ] n8n 실행 시 `queued → fetching → extracting → clustering → publishing → completed/failed`가 보이는지 확인합니다.
- [ ] publish 후 `pipeline_runs.status='published'`가 반영되는지 확인합니다.
- [ ] parse 오류 시 `parse_errors` 적재를 확인합니다.

## 5) 롤백

즉시 차단이 필요하면 아래 값을 사용합니다.

- Worker env `DETAIL_VIEW_ENABLED=false`
- Worker env `REPORT_V2_ENABLED=false`

파이프라인 롤백이 필요하면 이전 워크플로우 JSON을 다시 import하고 이전 Worker 버전을 재배포합니다. 기존 Cloudflare Pages 프로젝트는 2026-07-21 제거했으므로 Pages 기반 Web 롤백이 필요하면 보관한 배포 이력과 Web artifact로 프로젝트를 재생성합니다. 신규 cluster 테이블은 안정화 전 삭제하지 않습니다.

데이터 복구가 필요하면 Supabase 백업 또는 PITR 기준으로 복구합니다.
