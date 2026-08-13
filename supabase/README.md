# Supabase 설정

처음 설치할 때와 기존 데이터베이스를 업그레이드할 때 사용하는 SQL이 다릅니다.

| 상황 | 사용할 경로 |
| --- | --- |
| 비어 있는 새 Supabase 프로젝트 | `supabase/schema.sql` |
| 이미 운영 중인 프로젝트 | `supabase/migrations/`에서 아직 적용하지 않은 파일 |

## 새 프로젝트

SQL Editor에서 `supabase/schema.sql`을 한 번 실행합니다. 이 파일에는 현재 앱에 필요한 테이블, 인덱스, 제약 조건, RLS 정책, 명시적 Data API grant, view와 RPC가 최종 형태로 한 번씩 포함되어 있습니다. 새 프로젝트에서는 과거 migration을 다시 실행하지 않습니다.

## 기존 프로젝트

운영 DB에 적용된 변경 이력을 유지하고, 미적용 파일을 파일명 순서대로 적용합니다. 일부 파일만 골라 적용하거나 운영 DB를 비운 뒤 `schema.sql`로 다시 만드는 방식은 사용하지 않습니다. 실제 적용 전에는 [배포 runbook](../docs/deployment-runbook.md)의 사전 점검과 승인 절차를 따릅니다.

## 관리 원칙

- `schema.sql`은 새 설치를 위한 생성 artifact입니다. 직접 편집하지 않습니다.
- `migrations/`는 운영 데이터베이스의 순차 변경 이력이며, 적용된 파일은 이름이나 내용을 바꾸지 않습니다.
- 스키마 변경 시 새 migration을 추가한 뒤 PostgreSQL 17과 Docker를 사용해 snapshot을 갱신합니다.
- 애플리케이션과 CI는 두 경로의 핵심 보안·파이프라인 계약이 일치하는지 검증합니다.

```bash
node scripts/generate-supabase-schema.mjs
node scripts/generate-supabase-schema.mjs --check
```

생성기는 빈 로컬 PostgreSQL 17에 migration 전체를 파일명 순서로 적용하고 `public` catalog를 schema-only dump로 추출합니다. 기존 Supabase 프로젝트가 객체 생성 시 부여하던 Data API grant는 의도된 최종 객체 ACL로 보존하지만, 새 객체를 자동 노출하는 default privilege는 snapshot에 남기지 않습니다. 대상 프로젝트에 automatic Data API function grant가 남아 있어도 service-only RPC 자체가 `PUBLIC`, `anon`, `authenticated`를 명시적으로 revoke하도록 생성합니다. 생성에는 외부 Supabase 연결이나 운영 데이터가 필요하지 않습니다.

## 검증

정적 검증은 snapshot이 최신 최종 객체만 포함하고 migration ledger가 유지되는지 확인합니다. Runtime 검증은 한 임시 PostgreSQL 17 컨테이너에 서로 격리된 두 데이터베이스를 만듭니다.

- `fresh_path`: automatic Data API default grant를 먼저 재현한 뒤 `schema.sql` 적용
- `upgrade_path`: 기존 migration을 처음부터 순서대로 적용

검증기는 함수와 signature, relation column/default, 제약 조건, 인덱스, RLS와 policy, grant, view와 trigger catalog를 비교한 뒤 두 경로에 같은 semantic fixture를 실행합니다. 또한 모든 service-only RPC가 `anon`·`authenticated`에는 실행 불가이고 `service_role`에만 실행 가능한지 실제 PostgreSQL 권한으로 확인합니다.

```bash
npm run verify:database
npm run verify:database:runtime
```

이 검증은 로컬 임시 컨테이너만 만들고 종료 시 제거합니다. 운영 반영은 기존 프로젝트에는 새 migration만 적용하고, 새 프로젝트에만 `schema.sql`을 사용합니다. Snapshot 생성이나 검증은 운영 rollback 절차를 바꾸지 않습니다.
