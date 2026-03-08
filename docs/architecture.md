# VoC-Radar 아키텍처

## 시스템 역할

- **Web**: 공개 대시보드, 리뷰 조회, 로그인, 수집 요청 등록을 담당합니다.
- **Worker**: 공개/비공개/내부 API 단일 진입점, 캐시 갱신, 인증 검증을 담당합니다.
- **Supabase**: Auth, 테이블, RLS, 집계 함수를 담당합니다.
- **n8n**: queue claim, 리뷰 수집, AI 분석, 내부 API 호출을 담당합니다.

## 처리 흐름

1. 사용자가 Web에서 App Store ID와 국가를 선택합니다.
2. 로그인 사용자가 수집 요청을 만들면 `pipeline_jobs`에 queue가 생성됩니다.
3. n8n이 queue를 claim하고 실행 컨텍스트를 만듭니다.
4. n8n이 App Store RSS에서 최근 리뷰를 읽습니다.
5. Worker가 `get_existing_review_ids`로 이미 저장된 리뷰를 제거합니다.
6. n8n이 신규 리뷰를 AI에 전달해 우선순위, 유형, 요약을 만듭니다.
7. Worker가 `reviews`, `review_ai`, `pipeline_runs`를 upsert합니다.
8. publish 단계에서 Worker가 공개 캐시 버전을 갱신합니다.
9. Web은 Worker의 public/private API만 호출해 결과를 보여드립니다.

## API 경계

### Public API
로그인 없이 읽는 데이터입니다.

- 앱 메타
- 대시보드 요약
- 유형/이슈/트렌드
- 공개 리뷰 목록
- 최근 실행 이력

### Private API
로그인 사용자만 접근합니다.

- 수집 요청 생성
- 내 작업 이력 조회
- 작업 취소
- 비공개 리뷰 조회

### Internal API
n8n 전용입니다.

- queue claim
- 리뷰 fetch/filter
- upsert
- parse error 기록
- publish
- alert event 기록

## 보안 기준

- 내부 API는 `x-voc-token` 또는 HMAC 서명을 검증합니다.
- 비공개 API는 Supabase access token을 검증합니다.
- 상세 리뷰 접근은 `DETAIL_VIEW_ENABLED`로 즉시 차단할 수 있습니다.

## 운영 기준

- Web은 Worker만 호출합니다.
- Worker는 Supabase와 외부 App Store RSS만 호출합니다.
- DB 스키마의 최신 기준은 bootstrap SQL에 유지합니다.
- 변경 이력은 migration SQL로 보존합니다.
