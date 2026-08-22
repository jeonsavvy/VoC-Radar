# Agent-readable public web access

## Goal

- Make the public VoC Radar site useful to agents that do not execute JavaScript.
- Return truthful HTTP status codes without breaking supported React routes or static assets.
- Publish the existing read-only public API contract in machine-readable form.
- Fix the four Essential failures in the 2026-08-22 Is Agentic report: raw content, unknown-path 404s, OpenAPI discovery, and Markdown negotiation.

## Non-goals

- Deploying or rescanning production in this change.
- Server-rendering dynamic app reports.
- Publishing private or internal API operations.
- Adding a CLI, MCP server, developer account flow, or fabricated organization contact data for a score.

## Confirmed baseline facts (before this change)

- The public report scored 44/100: 4/8 Essential checks and 1/16 Recommended checks passed.
- `index.html` contains an empty React mount point, so its raw body has no product explanation.
- Workers Static Assets currently uses SPA fallback for every non-asset path, including paths that do not exist.
- The Worker exposes a read-only `/api/public/*` surface and structured JSON errors.

## Affected contract

- Exact static assets remain available through the `ASSETS` binding.
- `/`, `/privacy`, account pages, request history, and supported `/apps/:country/:appId/:tab` paths continue to receive the SPA shell.
- Unknown non-API paths return HTTP 404 with a short Markdown recovery body linking to `/sitemap.xml`, `/llms.txt`, and `/openapi.json`.
- Existing `/api/*` routing, service-readiness checks, CORS, and JSON errors do not change.
- `GET` or `HEAD /` with `Accept: text/markdown` returns the public agent guide. HTML and Markdown variants send `Vary: Accept, Accept-Encoding`.
- Raw homepage HTML contains a semantic Korean product summary with an H1 and at least 500 visible characters.
- `/openapi.json` documents only public GET operations and gives every operation a unique `operationId`, description, typed parameters, and response schemas.

## Chosen approach

Workers Static Assets will use `binding = "ASSETS"`, `run_worker_first = true`, and `not_found_handling = "none"`.

```text
request
  -> OPTIONS: existing CORS preflight
  -> non-API GET/HEAD
       -> root + Accept text/markdown: serve llms.txt as Markdown with Vary
       -> exact asset exists: return the asset
       -> supported React path: fetch the root HTML asset without redirecting the browser
       -> otherwise: return Markdown 404
  -> non-API other method: 405
  -> API: existing readiness check and route chain
```

Static `llms.txt`, `sitemap.xml`, and `openapi.json` files are copied by Vite. The initial HTML summary is replaced by the existing React root once JavaScript runs.

## Consequential assumptions

- Cloudflare's documented `ASSETS.fetch()` contract and Wrangler 4.115.0 support Worker-first asset routing.
- Supported React paths are intentionally finite. A new client route must be added to the Worker matcher in the same change.
- The OpenAPI document describes the current public read surface; private and internal paths remain intentionally undiscoverable there.

## Rollback

- Revert the Worker-first asset routing and restore the previous SPA fallback configuration.
- Remove the new static discovery files and initial HTML summary.
- No database, n8n, secret, or production data rollback is involved.

## Proving checks

- Focused Web artifact tests for raw text, discovery files, metadata, and OpenAPI-to-router parity.
- Focused Worker tests for exact assets, supported SPA routes, Markdown negotiation, unknown-path 404s, and unchanged API errors.
- `npm run verify`
- Built-output HTTP smoke checks for HTML, Markdown, sitemap, OpenAPI, supported deep links, and unknown paths.
- JavaScript-disabled desktop and mobile render review of the initial homepage.
