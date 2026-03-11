# Supabase 가이드

VoC-Radar의 Supabase SQL은 두 층으로 관리합니다.

- `20260307_voc_radar_bootstrap.sql`: 신규 설치용 최신 스키마입니다.
- `migrations/`: 변경 이력 보존용 SQL입니다.

## 어떤 파일을 실행해야 하나요

### 신규 프로젝트

아래 파일을 실행해 주시면 됩니다.

```sql
supabase/20260307_voc_radar_bootstrap.sql
```

### 운영 중인 프로젝트

- 기존 migration 체인을 유지해 주셔야 합니다.
- 운영 DB를 비운 뒤 bootstrap만 다시 적용하는 방식은 사용하지 않습니다.
- 최근 운영 보정 SQL에는 `202603110001_private_review_feed_security_invoker.sql`이 포함됩니다.

## bootstrap SQL에 포함된 것

- 테이블
  - `apps`
  - `reviews`
  - `review_ai`
  - `pipeline_runs`
  - `parse_errors`
  - `alert_events`
  - `pipeline_jobs`
- 인덱스
- review/category 관련 constraint
- RLS와 policy
- `private_review_feed` view (`security_invoker=true`, Worker의 service_role 조회용 read model)
- public/private 집계 함수와 queue 함수

## 운영 원칙

- 최신 기준은 bootstrap SQL에 반영합니다.
- 변경 이유와 순서는 migration SQL에 남깁니다.
- 신규 설치자는 bootstrap 하나만 보시면 됩니다.
- 운영 유지자는 migration 이력을 기준으로 추적하셔야 합니다.

## private_review_feed 참고

- `private_review_feed`는 리뷰 원문과 AI 분류 결과를 묶은 상세 조회용 view입니다.
- 이 view는 `security_invoker = true`를 사용합니다.
- 직접 DB에서 `authenticated`에 노출하지 않고, Worker가 access token 검증 후 `service_role`로 조회합니다.

## 점검 포인트

```sql
select count(*) from public.reviews;
select count(*) from public.review_ai;
select count(*) from public.pipeline_runs;
select count(*) from public.pipeline_jobs;
```
