# Supabase

VoC-Radar의 Supabase SQL은 **히스토리용 migration**과 **신규 설치용 bootstrap SQL**로 나뉩니다.

## 파일 구성

- `migrations/`
  - 개발/운영 중 누적된 변경 이력
  - 기존 프로젝트가 어떻게 현재 스키마에 도달했는지 보존하는 용도
- `20260307_voc_radar_bootstrap.sql`
  - **신규 환경 / 빈 프로젝트용 단일 SQL**
  - 지금 기준 최신 스키마/함수/뷰를 한 번에 생성

## 언제 뭘 실행해야 하나

### 1) 새 Supabase 프로젝트를 만드는 경우
아래 파일 **하나만** 실행하면 됩니다.

```sql
supabase/20260307_voc_radar_bootstrap.sql
```

### 2) 이미 운영 중인 Supabase 프로젝트를 유지하는 경우
기존 migration 체인을 유지하세요.

즉:
- 운영 DB에서 테이블/함수/뷰를 전부 지우고 bootstrap을 다시 실행하는 방식은 **권장하지 않습니다**
- 운영 DB는 기존 migration 기반으로 유지하는 것이 안전합니다

## “기존 SQL 다 지우고 다시 실행해도 되나?”

### 가능
- 로컬 테스트용
- 새 프로젝트
- 데이터가 없어도 되는 재구성 환경

### 비권장 / 금지에 가까움
- 현재 운영 데이터가 있는 프로젝트
- Auth 사용자/실데이터/실행 이력이 남아 있는 프로젝트

운영 DB에서 다시 깔고 싶다면:
1. 백업/PITR 확보
2. 새 프로젝트로 bootstrap 테스트
3. 데이터 이관 계획 확인
이 순서가 맞습니다.

## 왜 migration 파일이 많은가

이 저장소의 `migrations/`는 “난사”용이 아니라 **변경 이력 보존용**입니다.

다만 신규 설치 입장에선 불편하므로, 이번에 **bootstrap SQL 1개로 통합**했습니다.

즉 앞으로는:
- 신규 설치 → `bootstrap` 1개
- 변경 이력 확인/운영 diff 추적 → `migrations`

## 추천 운영 방식

- **신규 설치/초기 세팅**: `supabase/20260307_voc_radar_bootstrap.sql`
- **기존 운영 환경 유지**: 기존 migration 이력 유지
- **향후 추가 변경**: 새 migration 추가 + 필요하면 bootstrap 갱신
