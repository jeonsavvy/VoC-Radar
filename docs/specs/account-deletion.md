# 계정 탈퇴 계약

## 사용자 동작

- 로그인한 사용자만 `DELETE /api/private/account`를 호출할 수 있습니다.
- UI에서는 사용자가 `탈퇴`를 정확히 입력해야 삭제 버튼이 활성화됩니다.
- 성공하면 로컬 세션을 지우고 익명 홈으로 이동합니다.

## 데이터 처리

Worker는 bearer token으로 사용자를 확인한 뒤 다음 순서로 처리합니다.

1. `prepare_account_deletion` RPC가 사용자의 `queued`·`running` job을 취소합니다.
2. 같은 사용자가 남긴 `pipeline_jobs.note`를 삭제합니다.
3. Supabase Admin API로 Auth 사용자를 삭제합니다.

공개 App Store 앱, 리뷰, 분석 run과 이슈 snapshot은 계정 소유 데이터가 아니므로 유지합니다. `pipeline_jobs.requested_by`는 Auth 사용자 삭제 시 `null`이 됩니다.

성공 응답은 다음 형태입니다.

```json
{
  "ok": true,
  "data": {
    "deleted": true,
    "canceledJobs": 0,
    "redactedJobs": 0
  }
}
```

## 실패 복구

| 오류 코드 | 보장되는 상태 | 사용자 조치 |
| --- | --- | --- |
| `account_delete_not_started` | 계정은 유지됩니다. job 취소와 메모 삭제의 완료 여부는 확인되지 않았습니다. | 잠시 후 다시 시도합니다. |
| `account_delete_incomplete` | job 취소와 메모 삭제는 완료됐지만 Auth 사용자 삭제 결과는 확인되지 않았습니다. | 새로고침해 로그인 상태를 확인하고 계정이 남아 있으면 다시 시도합니다. |

계정 삭제 후 로컬 로그아웃만 실패한 경우 계정은 복구되지 않습니다. 새로고침해 세션 상태를 다시 확인합니다.

## 보안 경계

- service role key는 Worker 밖으로 노출하지 않습니다.
- `prepare_account_deletion`은 `service_role`만 실행할 수 있습니다.
- UI 상태만으로 삭제 성공을 판단하지 않고 API 결과를 확인합니다.
