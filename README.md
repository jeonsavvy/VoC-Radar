## 📝 프로젝트 소개 (Executive Summary)

> **"앱스토어 리뷰 자동 모니터링 에이전트"**

**VoC-Radar**는 **운영팀**을 위한 **리뷰 모니터링 자동화 시스템**입니다. **n8n 워크플로우와 Google Gemini API**를 활용하여 **앱스토어 리뷰의 수동 확인 작업**을 해결하고, 결과적으로 **실시간 알림과 자동화된 분석을 통한 신속한 대응**을 제공합니다.

* **제작:** jeonsavvy@gmail.com

---

## ✨ 핵심 기능 (Key Features)

<table>
  <tr>
    <td align="center" width="50%">
      <h3>🔹 자동 리뷰 수집 및 분석</h3>
      <p>지정된 시간마다 자동으로 iTunes App Store RSS API에서 최신 리뷰 50개를 수집하고, Google Gemini AI를 활용하여 리뷰의 긴급도(Critical/High/Normal)와 유형(버그/사용성/칭찬/기타), 요약 정보를 자동 추출합니다.</p>
    </td>
    <td align="center" width="50%">
      <h3>🔹 중복 제거 및 데이터 관리</h3>
      <p>기존 Google Sheets 데이터와 비교하여 중복 리뷰를 자동으로 제거하고, 구조화된 형식(작성일시, 작성자, 별점, 긴급도, 유형, 요약, 원본)으로 저장하여 데이터 누적 관리를 통한 리뷰 트렌드 파악이 가능합니다.</p>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <h3>🔹 실시간 알림</h3>
      <p>Critical로 분류된 긴급 리뷰 발견 시 텔레그램 봇을 통해 즉시 알림을 전송하며, 알림 메시지에 작성자, 별점, 긴급도, 유형, 요약, 원본 리뷰, 작성일시를 포함하여 신속한 대응이 가능합니다.</p>
    </td>
    <td align="center" width="50%">
      <h3>🔹 워크플로우 자동화</h3>
      <p>n8n 기반의 워크플로우를 통해 리뷰 수집부터 분석, 저장, 알림까지 전체 프로세스를 자동화하여 수동 작업 시간을 최소화하고 운영 효율성을 극대화합니다.</p>
    </td>
  </tr>
</table>

---

## 🏗 아키텍처 및 워크플로우 (Architecture)

### 🔄 데이터 흐름

1. **수집 (Input):** iTunes App Store RSS API를 호출하여 최신 리뷰 50개를 JSON 형식으로 수집합니다. Schedule Trigger를 통해 매일 지정된 시간(기본: 09:00 KST)에 자동 실행됩니다.

2. **처리 (Process):** 
   - Google Gemini AI를 활용하여 각 리뷰의 긴급도(Critical/High/Normal), 유형(버그/사용성/칭찬/기타), 요약 정보를 자동 추출
   - AI 응답을 JSON으로 파싱하고 원본 리뷰 데이터와 매칭하여 구조화된 데이터 생성
   - Google Sheets에서 기존 리뷰를 읽어와 중복 여부 확인
   - 중복이 아닌 리뷰만 Google Sheets에 추가 (컬럼: 작성일시, 작성자, 별점, 긴급도, 유형, 요약, 원본)
   - Critical로 분류된 리뷰만 필터링하여 알림 대상으로 선별

3. **결과 (Output):** Critical 리뷰를 텔레그램 봇을 통해 즉시 알림 전송하며, 모든 리뷰 데이터는 Google Sheets에 구조화되어 저장되어 추후 분석이 가능합니다.

### 📊 워크플로우 구조

```
Schedule Trigger (Daily 09:00 KST)
    ↓
HTTP Request (리뷰 50개 가져오기)
    ├─→ Basic LLM Chain (AI 분석)
    │       ↓
    │   Parse JSON Response
    │       ↓
    │   Filter Duplicates
    │       ↓
    │   Append row in sheet
    │       ↓
    │   Check Critical Priority
    │       ↓
    │   Send Telegram Alert
    │
    └─→ Get Existing Reviews
```

### 📸 결과물 예시

> 💡 **참고**: 아래 예시 자료는 '당근' 애플리케이션의 리뷰를 활용하여 제작되었습니다.

**n8n 워크플로우 구조**
![워크플로우 예시](assets/workflow_example.png)

**Google Sheets 저장 결과**
![Google Sheets 예시](assets/sheet_example.png)

**텔레그램 알림 결과**
![텔레그램 알림 예시](assets/telegram_example.png)

---

## 🛠 기술 스택 (Tech Stack)

| 구분 | 기술 (Technology) | 선정 이유 (Reason) |
| :--- | :--- | :--- |
| **Workflow Automation** | n8n (Self-hosted) | 시각적 워크플로우 구축과 다양한 API 통합이 용이하며, 무료 오픈소스로 프로토타입 개발에 적합 |
| **AI / ML** | Google Gemini API | 리뷰 분석을 위한 자연어 처리 능력과 무료 티어 제공으로 프로토타입 테스트에 적합 |
| **Data Source** | iTunes App Store RSS API | 앱스토어 리뷰 데이터를 구조화된 JSON 형식으로 제공하여 파싱이 용이 |
| **Storage** | Google Sheets API | 프로토타입 단계에서 별도 DB 구축 없이 빠르게 데이터 저장 및 관리 가능, CSV 내보내기로 Tableau 등 BI 도구와 연동 용이 |
| **Notification** | Telegram Bot API | 실시간 알림 전송이 간단하고 설정이 쉬우며, 모바일 푸시 알림 지원 |
| **Development** | Cursor | AI 기반 코드 작성 지원으로 개발 효율성 향상 |

---

## 🚀 시작 가이드 (Getting Started)

### 전제 조건 (Prerequisites)

* n8n (Self-hosted 또는 Cloud 버전)
* Google Gemini API 키
* Google Cloud Console 계정 (Google Sheets API 사용)
* Telegram Bot Token

### 설치 및 실행 (Installation)

1. **레포지토리 클론**

   ```bash
   git clone https://github.com/ieonsavvy/VoC-Radar.git
   cd VoC-Radar
   ```

2. **n8n 워크플로우 Import**

   * n8n 대시보드에 접속하여 `workflow.json` 파일을 import합니다.

3. **환경 변수 및 Credentials 설정**

   **Google Gemini API**
   * [Google AI Studio](https://makersuite.google.com/app/apikey)에서 API 키 생성
   * n8n Credentials에서 `Google Gemini Chat Model` 노드에 API 키 연결

   **Google Sheets OAuth2**
   * [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성
   * Google Sheets API, Google Drive API 활성화
   * OAuth 2.0 Client ID 생성
   * Authorized redirect URI: `http://localhost:5678/rest/oauth2-credential/callback`
   * n8n Credentials에 Client ID, Secret 입력

   **Telegram Bot**
   * 텔레그램에서 [@BotFather](https://t.me/botfather) 검색 후 대화 시작
   * `/newbot` 명령어 입력 후 봇 이름과 사용자명 설정
   * 생성된 Bot Token을 `Send Telegram Alert` 노드의 Credentials에 입력

4. **워크플로우 노드 설정**

   **Google Sheets 설정**
   * `Get Existing Reviews` 노드: Document 필드에 Google Sheets ID 입력
   * `Append row in sheet` 노드: 동일한 Google Sheets ID 입력
   
   **Telegram 설정**
   * `Send Telegram Alert` 노드: Chat ID 필드에 텔레그램 Chat ID 입력
   * Chat ID 확인: [@userinfobot](https://t.me/userinfobot)으로 본인의 Chat ID 확인

   **앱 ID 변경 (선택사항)**
   * `HTTP Request` 노드의 URL에서 앱 ID 수정
   * 형식: `https://itunes.apple.com/{국가코드}/rss/customerreviews/limit={개수}/id={앱ID}/sortBy=mostRecent/json`
   * 앱 ID 찾는 방법: App Store에서 앱 검색 후 URL의 `id=` 뒤 숫자 확인

5. **프로젝트 실행**

   * n8n 대시보드에서 워크플로우를 활성화하면 Schedule Trigger에 따라 자동 실행됩니다.
   * 기본 실행 시간: 매일 09:00 KST (Schedule Trigger 노드에서 변경 가능)

---

## 📂 폴더 구조 (Directory Structure)

```bash
├── assets/              # 이미지 및 정적 파일
│   ├── workflow_example.png
│   ├── sheet_example.png
│   └── telegram_example.png
├── workflow.json        # n8n 워크플로우 설정 파일
└── README.md            # 프로젝트 문서
```

---

## ⚡ 트러블 슈팅 (Troubleshooting)

| 문제 (Issue) | 원인 (Cause) | 해결 (Solution) |
| --- | --- | --- |
| **중복 리뷰 제거 로직의 문제** | 노드간 Google Sheets에서 읽은 데이터의 컬럼명 인식 불일치 문제 | 컬럼명 경로를 체크하는 로직 추가 (원본/content, 작성자/author 등). 워크플로우 안정성 향상 |
| **토큰 비용 최적화** | Gemini API 일반 계정(분당 최대 요청 수 5) 한도 초과 위험 | 리뷰 데이터를 배치 처리로 한 번에 전송하여 API 호출 횟수 최소화. Gemini API 일반 계정에서도 프로토타입 테스트 가능 |
| **Google Sheets 접근 권한 오류** | OAuth2 인증이 제대로 설정되지 않음 | Google Cloud Console에서 OAuth 2.0 Client ID가 올바르게 생성되었는지 확인하고, redirect URI가 정확히 설정되었는지 확인 |
| **텔레그램 알림이 전송되지 않음** | Chat ID 또는 Bot Token이 잘못 입력됨 | [@userinfobot](https://t.me/userinfobot)으로 Chat ID 재확인 및 Bot Token이 올바르게 설정되었는지 확인 |

---

## 📊 워크플로우 노드 상세

| Node | Description |
|------|-------------|
| **Schedule Trigger** | 매일 지정된 시간에 자동 실행 (기본: 09:00 KST) |
| **HTTP Request** | iTunes App Store RSS API에서 리뷰 데이터 수집 (최대 50개) |
| **Basic LLM Chain** | Gemini로 리뷰 분석 (긴급도/유형/요약) |
| **Parse JSON Response** | AI 응답 JSON 파싱 및 원본 데이터 매칭 |
| **Get Existing Reviews** | Google Sheets에서 기존 리뷰 읽기 (중복 체크용) |
| **Filter Duplicates** | 중복 리뷰 제거 |
| **Append row in sheet** | 새 리뷰를 Google Sheets에 추가 |
| **Check Critical Priority** | Critical 리뷰 필터링 |
| **Send Telegram Alert** | Critical 리뷰 텔레그램 알림 전송 |

---

## 🔧 Configuration

### 실행 시간 변경

`Schedule Trigger` 노드에서 `hour`와 `minute` 값 수정

### AI 분석 기준 변경

`Basic LLM Chain` 노드의 `text` 필드에서 프롬프트 수정

### 다른 앱으로 변경하기

`HTTP Request` 노드의 URL 수정:
```
https://itunes.apple.com/{국가코드}/rss/customerreviews/limit={개수}/id={앱ID}/sortBy=mostRecent/json
```

---

## 🔒 Security Notes

- ✅ Google Sheets ID: 각 노드에서 직접 입력
- ✅ 텔레그램 Chat ID: 각 노드에서 직접 입력
- ✅ Credentials: n8n 내부 참조 ID만 포함 (실제 토큰/키 없음)

**사용 전 필수 설정:**
1. 각 노드에 본인의 정보 입력
2. n8n Credentials에 본인의 API 키/토큰 연결

