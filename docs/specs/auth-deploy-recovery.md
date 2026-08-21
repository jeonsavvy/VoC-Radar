# Authentication and deployment recovery

## Goal

- Restore production builds without weakening the fail-closed Worker deployment contract.
- Make email signup truthful for both Supabase confirmation modes.
- Give login, signup, confirmation resend, and password recovery clear states and safe recovery copy.
- Keep the authentication page aligned with the repository design contract on desktop and mobile.

## Non-goals

- Changing the database schema, RLS policies, or Worker API authorization.
- Replacing Supabase Auth or adding social providers.
- Displaying raw provider errors or provider configuration details to users.
- Changing the established neutral/cobalt visual system.

## Incident facts at recovery start

- Cloudflare completes the Web build and then stops in the deploy command because the production build trigger does not provide `REPORT_V2_ENABLED` or `DETAIL_VIEW_ENABLED`.
- The live Worker reports both flags as enabled. The deployment wrapper intentionally requires both values and passes them to Wrangler explicitly.
- The currently deployed Web bundle was compiled without the two public Supabase variables, so login and signup stop before contacting Supabase.
- Supabase returns no signup session when email confirmation is required and returns a session when confirmation is disabled.
- The current signup implementation treats the second valid result as an error after the account has already been created.

## Product surface contract

- User: someone who wants to request analysis or review their requests.
- Primary job: sign in, or create and verify an account, without losing the destination that prompted authentication.
- Costly failure: the UI claims an email was sent or signup failed when neither statement is true.
- Page role: a focused account gateway, not a dashboard or marketing page.
- Required states: login, signup, pending email confirmation, immediately usable account, validation error, provider error, service unavailable, resend sent, password reset requested, password update, and loading.
- Recovery: errors identify the next safe action without exposing raw Supabase messages.
- Layout: one compact auth surface with mode-specific heading, restrained borders, no decorative effects, and a mobile-safe reading order.

## Affected contracts

### Cloudflare deployment

- Keep `scripts/deploy-worker.mjs` fail-closed.
- Set both feature flags on the production build trigger to the verified live values.
- Preserve existing Supabase build variables without reading or logging their values.
- Retry the pinned production commit, inspect the complete build log, and verify the active deployment and `/api/health` before considering the rollout complete.

### Auth library

- `signUpWithPassword()` returns `{ requiresEmailVerification: boolean }` for both valid Supabase outcomes.
- If signup returns a session, sign out locally and return success with `requiresEmailVerification: false`; do not report a false failure.
- Classify Auth failures by stable `code`, not message text. Unknown failures use a safe generic message.
- Add bounded helpers for confirmation resend, password-reset email, and password update using the current origin and sanitized return path.

### Auth UI

- Snapshot the submitted mode and disable mode/input changes while a request is active.
- Use mode-specific heading, explanation, CTA, success message, and return-destination context.
- Associate validation errors with their fields using `aria-invalid` and `aria-describedby`; announce submission failures with an alert and focus the first actionable error.
- Offer confirmation resend after a pending signup and password recovery from login.
- Keep the privacy link visible near account creation.

## Key state flow

```text
signup submit
  -> local mismatch: focus confirmation field and stop
  -> Supabase error: map error code to safe recovery copy
  -> session is null: show pending-confirmation state and resend action
  -> session exists: sign out, show account-created state, switch to login

password recovery
  -> request reset email with /reset-password redirect
  -> callback restores a recovery session
  -> user submits a new password
  -> update password, sign out, refresh the parent session, return to login
```

## Production checks and remaining assumptions

- Verified on 2026-08-21: the deployed Supabase project enables the email provider, allows signup, and requires email confirmation.
- Unverified: production email delivery uses a configured custom SMTP service. Supabase default SMTP is not considered a production guarantee.
- Unverified: the production Site URL and redirect allowlist include `https://voc-radar.satinode.com/**` for confirmation and password recovery.

## Rollout and rollback

- Capture the current Cloudflare build-variable key set and active Worker version before mutation.
- Upsert only the two missing feature-flag keys; preserve every existing key unchanged.
- If the retry fails before deployment, restore the previous build-variable set only if the new keys caused the failure; otherwise keep the corrected contract and fix the new first error.
- If the deployed Worker fails health or public smoke checks, restore the previously active Worker version. Do not change database or workflow state as part of this rollback.

## Proving checks

- Focused Web auth regression tests, including both signup session modes and safe error-code mapping.
- `npm run test --workspace @voc-radar/web`
- `npm run verify:release-config`
- `npm run verify`
- Desktop and mobile renders of login, signup, validation, and recovery states.
- Production build log shows both build and deploy commands succeeded.
- Production bundle contains an initialized Supabase client, `/api/health` returns `200`, and a non-mutating Auth request reaches the configured project.
- A real signup/email/callback check uses an explicitly designated test address and removes the test account afterward.
