# VoC-Radar v2 Architecture

## Core decision

- n8n remains orchestration backbone.
- Supabase is the single source of truth.
- Worker is the only BFF layer for public/private/internal APIs.
- Pages frontend consumes Worker APIs.

## Data flow

1. n8n fetches iTunes RSS.
2. n8n requests Gemini classification.
3. n8n normalizes + signs payload.
4. Worker verifies HMAC + upserts Supabase tables.
5. Worker updates cache version on publish event.
6. Frontend reads public/private endpoints.

## Security defaults

- Internal endpoints are HMAC-verified and fail-closed.
- Private reviews endpoint validates Supabase bearer token.
- `DETAIL_VIEW_ENABLED` controls emergency access shutdown.

## Rollback

- Keep dual-write to Google Sheets for temporary fallback.
- Keep `n8n/workflow.v1.json` as rollback baseline.
- Set `DETAIL_VIEW_ENABLED=false` to disable private exposure.
