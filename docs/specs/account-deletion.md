# Account deletion

## Background
- VoC-Radar uses Supabase Auth for email/password sessions.
- Authenticated users can create `pipeline_jobs`; public App Store app/review/analysis rows are shared service data, not account-owned rows.
- `pipeline_jobs.requested_by` references `auth.users(id)` with `on delete set null`.

## Goal
- Let a logged-in user withdraw their own account from the UI.
- Cancel that user's queued/running collection jobs before deleting the Supabase auth user.
- Keep public review and analysis data available.

## Non-goals
- No manual production DB delete.
- No deletion of public App Store review, app, run, or AI-analysis rows.
- No change to auth provider settings, RLS, or DB schema.

## Scope
- `DELETE /api/private/account`
- Shell account deletion UI for logged-in users.

## Constraints
- API must require the caller's bearer token.
- Service role key stays server-side in the Worker.
- The operation is destructive and one-way from the user's perspective.

## Affected contracts
- API: new authenticated `DELETE /api/private/account` returning `{ ok, data }`.
- DB: updates `pipeline_jobs` for current user and deletes `auth.users` via Supabase Admin API.
- Frontend state: on success signs out and returns to the home/dashboard route.

## Core logic
1. Verify bearer token through Supabase `/auth/v1/user`.
2. Patch current user's `queued`/`running` jobs to `canceled`.
3. Delete the auth user with the service role Admin API.
4. Return deletion/cancel count.

## Pseudocode
```text
user = getAuthUser(authorization)
if !user: 401
canceled = patch pipeline_jobs where requested_by=user.id and status in queued,running
adminDelete /auth/v1/admin/users/{user.id}
return { ok: true, data: { deleted: true, canceledJobs: canceled.length } }
```

## Breadboard / shaped flow
- Header shows `계정 탈퇴` only when logged in.
- Clicking opens an inline confirmation panel.
- User types `탈퇴` to enable the destructive action.
- Success signs out and reloads the anonymous home.
- Failure keeps the session and shows inline error text.

## Edge cases
- Missing/invalid token -> 401.
- Supabase Admin failure -> 500 and account remains signed in.
- Already no running jobs -> cancel count is 0 and deletion continues.

## Task breakdown
- Add Worker helper and route.
- Add Web API client helper.
- Add confirmation UI.
- Add tests for route/UI.

## Verification plan
- `npm run test --workspace @voc-radar/web`
- `npm run lint --workspace @voc-radar/web`
- `npm run build:web`
- `npm run test --workspace @voc-radar/worker`
- `npm run build:worker`

## Open questions / assumptions
- Public app/review/analysis records are retained because they are not account-owned data.
