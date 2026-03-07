# VoC-Radar 아키텍처

## 핵심 원칙

1. 파이프라인 실행은 n8n이 담당한다.
2. 데이터 원본은 Supabase로 통일한다.
3. API 진입점은 Cloudflare Worker 하나로 통일한다.
4. 프론트엔드는 Worker API만 호출한다.

## 처리 흐름

1. 사용자가 웹에서 분석 요청을 등록한다. (`pipeline_jobs`)
2. Worker가 n8n webhook을 호출하거나, n8n 1분 폴링이 요청을 가져간다.
3. n8n이 Worker 내부 API로 최근 리뷰를 수집한다. (기본 30일/120페이지, 페이지당 50건, 상한 10,000건)
4. n8n이 기존 `review_id`를 조회해 신규 리뷰만 남긴다.
5. n8n이 신규 리뷰를 최대 50개씩 LLM에 전달해 분석한다.
6. 분석 결과를 Worker 내부 API로 전송한다.
7. Worker가 Supabase(`reviews`, `review_ai`, `pipeline_runs`)에 upsert한다.
8. publish 이벤트에서 Worker 캐시 버전을 갱신한다.
9. 프론트는 공개/비공개 API를 통해 결과를 조회한다.
10. 공개 대시보드는 문제(issue)·원인(reason)·액션(action) read model을 조합해 보여준다.

## 보안 기본값

- 내부 API는 `x-voc-token` 또는 서명 헤더를 검증한다.
- 비공개 API는 Supabase access token을 검증한다.
- `DETAIL_VIEW_ENABLED`로 상세 화면 접근을 즉시 차단할 수 있다.

## 장애 대응

- 파싱 실패 데이터는 `parse_errors`에 기록한다.
- 작업 취소 API로 대기/실행중 요청을 정리할 수 있다.
- 필요 시 이전 워크플로우 JSON 재배포로 즉시 롤백한다.
