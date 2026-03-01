# VoC-Radar v2 Architecture

## Core decision

- n8n remains orchestration backbone.
- Supabase is the single source of truth.
- Worker is the only BFF layer for public/private/internal APIs.
- Pages frontend consumes Worker APIs.

## Data flow

1. Frontend can enqueue app analysis requests (`pipeline_jobs`).
2. n8n claims queued jobs first, then fallback app 설정으로 실행.
3. n8n fetches iTunes RSS.
4. n8n prefilters existing review IDs via Worker internal endpoint.
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

- Keep dual-write to Google Sheets for temporary fallback.
- Keep `n8n/workflow.v1.json` as rollback baseline.
- Set `DETAIL_VIEW_ENABLED=false` to disable private exposure.
