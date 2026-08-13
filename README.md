# VoC Radar

VoC Radar는 App Store 리뷰를 반복 이슈와 근거 리뷰로 묶어 공개 리포트로 제공합니다. 리포트 조회에는 로그인이 필요 없고, 신규 분석과 새로고침 요청에는 로그인이 필요합니다. n8n이 중지되어도 이미 게시된 리포트는 계속 제공됩니다.

## 로컬 실행

지원 Node.js 버전은 `package.json`의 `engines.node`를 따릅니다. 의존성을 설치한 뒤 Worker와 Web 개발 서버를 별도 터미널에서 실행합니다.

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

## 제품 경로

- `/`: 앱 탐색
- `/apps/:country/:appId/overview`: 공개 리포트 요약
- `/apps/:country/:appId/issues`: 이슈 목록과 근거 리뷰
- `/apps/:country/:appId/reviews`: 공개 리뷰
- `/requests`: 로그인 사용자의 분석 요청 내역

## 구성요소

| 경로 | 책임 |
| --- | --- |
| `apps/web` | React/Vite 탐색·리포트 UI, 응답 검증, 요청 취소와 화면 상태 |
| `apps/worker` | Web 정적 자산, public/private/internal API, Apple I/O, 입력 정규화와 인증 |
| `n8n` | webhook·5분 poll, 순차 모델 호출, checkpoint와 heartbeat |
| `supabase` | job 상태, claim·lease·attempt, 비공개 staging, fencing과 원자적 publish |

세부 책임과 데이터 흐름은 [아키텍처](docs/architecture.md)를 참조합니다.

## 수정할 원본

| 계약 | 수정할 파일 | 생성물 또는 adapter |
| --- | --- | --- |
| cluster enum·길이·입력 상한·대표 review ID·정확히 한 번 배정 | `contracts/cluster-contract.mjs` | Worker·Node adapter와 n8n 주입값 |
| cluster 경계 fixture | `contracts/cluster-contract.fixtures.mjs` | Worker·Node·n8n 검증 |
| workflow graph | `n8n/workflow.template.json` | `n8n/workflow.supabase-only.json` |
| workflow Code node | `n8n/code/*.js` | 생성 workflow의 `jsCode` |
| 기존 DB 업그레이드 | `supabase/migrations/*.sql` | 운영 migration ledger |
| 새 DB 설치 | `scripts/generate-supabase-schema.mjs` | `supabase/schema.sql` |

`n8n/workflow.supabase-only.json`과 `supabase/schema.sql`은 직접 편집하지 않습니다.

```bash
node scripts/build-workflow-v2.mjs
node scripts/build-workflow-v2.mjs --check
node scripts/generate-supabase-schema.mjs
node scripts/generate-supabase-schema.mjs --check
```

## API 경계

- Public API: 앱 탐색, 리포트, 이슈, 리뷰와 아트워크 조회
- Private API: 분석 요청·취소·내역, 사용자 리뷰 조회와 계정 탈퇴
- Internal API: n8n의 claim, heartbeat, persistence와 publish 명령

Public Web은 Supabase RPC를 직접 호출하지 않습니다. Worker가 공개 응답, Apple upstream, 인증과 payload 경계를 맡고 SQL이 durable job 상태와 publish를 맡습니다. 정확한 route와 요청 계약은 `apps/worker/src/public.ts`, `apps/worker/src/private.ts`, `apps/worker/src/internal.ts`가 기준입니다.

계정 탈퇴의 데이터 처리와 부분 실패 복구는 [계정 탈퇴 계약](docs/specs/account-deletion.md)에 정의합니다.

## 검증

일반 변경은 전체 검증을 실행합니다.

```bash
npm run verify
```

DB migration이나 생성 snapshot을 변경했다면 PostgreSQL 17의 fresh/upgrade 경로도 비교합니다.

```bash
node scripts/generate-supabase-schema.mjs --check
npm run verify:database:runtime
```

## 운영 문서

- [아키텍처와 계약 소유권](docs/architecture.md)
- [배포·진단·rollback 런북](docs/deployment-runbook.md)
- [Supabase 새 설치와 업그레이드](supabase/README.md)
- [UI 디자인 계약](DESIGN.md)
