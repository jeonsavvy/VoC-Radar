# VoC-Radar

iTunes App Store 리뷰를 주기적으로 수집해서, Gemini로 분류/요약하고 Google Sheets에 적재하며, `Critical` 항목만 Telegram으로 알림 보내는 n8n 워크플로우입니다.

---

## 핵심 흐름

```mermaid
graph TD
    A[Schedule Trigger (Hourly)] --> B[HTTP Request: iTunes RSS]
    B --> C[Get Existing Reviews: Google Sheets]
    C --> D[Basic LLM Chain + Gemini]
    D --> E[Parse JSON Response]
    E --> F[Filter Duplicates]
    F --> G[Append row in sheet]
    G --> H{Check Critical Priority}
    H -->|Yes| I[Prepare Telegram Data]
    I --> J[Send Telegram Alert]
```

---

## 현재 구현 기능

- **수집 주기**: 1시간 간격 스케줄
- **소스**: iTunes RSS (`limit=50`, `sortBy=mostRecent`)
- **AI 분석 결과**: `priority`, `category`, `summary`
- **중복 제거**: 기존 시트의 `ID` 기준 필터링
- **알림 조건**: priority 문자열에 `Critical` 포함 시만 Telegram 전송

---

## 빠른 시작

### 1) 워크플로우 Import

- n8n → Workflows → Import from File
- `workflow.json` 업로드

### 2) Credential 연결

- Google Gemini
- Google Sheets OAuth2
- Telegram Bot

### 3) 노드 설정

- `HTTP Request`: 앱 ID/국가코드 필요 시 수정
- `Get Existing Reviews` / `Append row in sheet`: 문서 ID, 시트명 연결
- `Send Telegram Alert`: Chat ID 설정

### 4) 실행

- `Execute Workflow`로 테스트
- 검증 후 `Active` ON

---

## 중요: Import 후 꼭 확인할 항목

현재 `workflow.json`에는 스케줄 노드 연결 키가 과거 이름(`Schedule Trigger (Daily 09:00 KST)`)으로 남아 있습니다.

- 실제 노드 이름: `Schedule Trigger (Hourly Strategy)`
- 따라서 **Import 후 Schedule → HTTP Request 연결이 정상인지** n8n 에디터에서 반드시 확인/재연결하세요.

---

## 주의사항 (현재 상태)

- README에서 흔히 쓰는 “별점 1~2 + Critical” 복합 조건이 아니라, 실제 IF 노드는 `priority contains Critical` 기준입니다.
- HTTP Request 노드에 명시적 retry/timeout 옵션은 현재 JSON에 설정되어 있지 않습니다.

---

## 파일 구조

```bash
├── workflow.json
├── assets/
└── README.md
```
