# AGENTS.md

## Purpose

VoC-Radar collects App Store reviews, queues analysis jobs, serves public dashboards, and connects the web app, Cloudflare Worker API, Supabase, and n8n pipeline.

## Structure

- `apps/web/`: React/Vite frontend.
- `apps/worker/`: Cloudflare Worker API and BFF.
- `supabase/`: bootstrap and migration SQL.
- `n8n/`: workflow artifact.
- `docs/`: architecture and deployment runbooks.

## Safe commands

```bash
npm install
npm run lint
npm run typecheck
npm run build
npm run verify:workflow
```

## Risk boundaries

- Do not write to Supabase, n8n, Cloudflare, or production APIs without explicit approval.
- Do not print or commit `SUPABASE_SERVICE_ROLE_KEY`, `PIPELINE_WEBHOOK_SECRET`, or n8n secrets.
- Treat `apps/worker` private/internal endpoints and `supabase/` migrations as high-risk surfaces.

## Reporting

Report changed files, verification commands, pass/fail status, and any production rollout or rollback notes.
