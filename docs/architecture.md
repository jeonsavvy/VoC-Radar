# VoC-Radar v2 Architecture

## Core decision

- n8n remains orchestration backbone.
- Supabase is the single source of truth.
- Worker is the only BFF layer for public/private/internal APIs.
- Pages frontend consumes Worker APIs.

## Data flow

1. Frontend can enqueue app analysis requests (`pipeline_jobs`).
2. Worker가 n8n webhook을 즉시 호출하고, n8n은 queued job을 우선 claim한 뒤 fallback app 설정으로 실행.
3. n8n fetches iTunes reviews through Worker internal endpoint (`/fetch-reviews`, 최대 500).
4. n8n prefilters existing review IDs via Worker internal endpoint (`/filter-new-reviews`).
5. n8n requests Gemini classification only for new reviews.
6. n8n normalizes + signs payload.
7. Worker verifies HMAC + upserts Supabase tables.
8. Worker updates cache version on publish event.
9. Frontend reads public/private endpoints + job status.

## Security defaults

- Internal endpoints are HMAC-verified and fail-closed.
- Private reviews endpoint validates Supabase bearer token.
- `DETAIL_VIEW_ENABLED` controls emergency access shutdown.

## Rollback

- Rollback via previous Git commit workflow re-import.
- Set `DETAIL_VIEW_ENABLED=false` to disable private exposure.
