# Source-of-truth simplification

## Goal

- Keep the current Web, Worker, Supabase, and n8n runtime boundaries while giving each durable invariant one authoritative source.
- Remove the verified cluster-contract drift, self-referential workflow build, migration-history bootstrap schema, duplicated domain ownership, and compensating Web/test behavior.
- Preserve public API behavior, authentication boundaries, job fencing, incomplete-scope rejection, private staging, and atomic publish.

## Confirmed repository facts

- Worker cluster summaries are bounded to 400 characters while the Node workflow verifier uses 500.
- The Worker limits cluster input to 10,000 reviews; the Node verifier does not enforce the same upper bound.
- n8n caps supplied representative review IDs to three; the Worker does not apply the same cap to a supplied valid subset.
- `scripts/build-workflow-v2.mjs` reads and writes `n8n/workflow.supabase-only.json`; `--check` proves only that the checked-in artifact is a fixed point of the patcher.
- `supabase/schema.sql` contains superseded function definitions and historical backfill steps even though it is the fresh-install path.
- Priority, stage, retry, report-window, and artwork-fallback behavior have multiple owners.
- Source-regex tests protect implementation form in addition to observable behavior.
- The local n8n service is currently stopped, and the Cloudflare and GitHub deployment surfaces are authenticated.
- The Supabase connector currently exposes a different project whose schema and migration ledger do not match VoC Radar. That project is excluded from every write and cannot prove the VoC Radar production database state.

## Consequential assumptions

- The Worker 400-character summary behavior is the compatibility baseline until a product requirement says otherwise.
- Existing migration files are immutable upgrade history. A clean `schema.sql` is a generated fresh-install artifact, not a replacement for the migration ledger.
- The checked-in n8n JSON remains a portable deployment artifact; its graph and Code-node source must be generated one-way from independent inputs.
- A compatibility endpoint or feature flag is retained unless repository and live deployment evidence prove it has no caller and no rollback role.
- Existing numeric caps remain unchanged unless this work measures a failure boundary or an authoritative product/runtime contract supplies a replacement.

## Non-goals

- No new deployed service, queue, ORM, state-management framework, or workflow engine.
- No collapse of public, private, and internal Worker policies.
- No removal of claim keys, claim tokens, leases, heartbeat fencing, staging, RLS, or atomic publish.
- No destructive database rollback, data rewrite, retention TTL, or compatibility-route deletion based only on static reachability.
- No change to user quota, pipeline attempt, lease, collection-page, or model-batch limits without separate provenance.

## Contract ownership after the change

| Contract | Authoritative owner | Other enforcement points |
| --- | --- | --- |
| Cluster enums, lengths, input cap, representative cap, exact ID assignment | shared deterministic contract source used by Worker and Node tests | n8n early adapter and SQL transaction constraints run the same fixture corpus |
| Durable job status, claim, lease, attempt, stage monotonicity, staging, publish | SQL | Worker exposes verb endpoints; n8n sends commands and treats claim loss as terminal for that execution |
| Apple I/O, payload normalization, persisted priority, internal authentication | Worker | n8n sends raw model/review facts and does not reimplement persisted priority |
| Workflow graph and Code-node bodies | n8n template plus external Code-node source files | one-way packer produces `workflow.supabase-only.json`; validator compares regenerated output |
| Fresh database install | generated clean `supabase/schema.sql` | immutable migrations remain the upgrade source; isolated install paths run the same semantic fixtures |
| Public report time window and success DTO | Worker response contract | Web runtime-decodes the response and reuses the returned window for dependent reads |
| UI request lifecycle | Web resource state and `AbortSignal` | API helper composes caller cancellation with timeout and idempotent-read retry |
| Retry semantics | owning runtime plus one documented combined policy | tests cover retryable/non-retryable classification without changing current numeric limits |

## Shaped flow

```text
Web ── public/private HTTP ──> Worker ── RPC ──> Supabase
                                  └──── Apple

n8n trigger/poll
  -> claim through Worker
  -> ordered model calls
  -> early deterministic validation
  -> heartbeat
  -> submit canonical result through Worker
  -> SQL staging and atomic publish
```

```text
enqueue
  -> claim(job_id, claim_token, lease_until, run_id)
  -> heartbeat(stage)
  -> persist_staged_result
  -> publish

failure branches:
  invalid model result -> fail current job attempt according to existing policy
  claim lost/canceled  -> reject stale execution without data publication
  execution death      -> SQL lease recovery on the existing attempt policy
```

## Chosen implementation

### Shared cluster contract

- Put contract constants and deterministic normalization/validation in one runtime-neutral module.
- Make the existing Worker and script entry points thin adapters or re-exports so callers do not gain a second implementation.
- Keep an n8n-compatible early adapter because Code nodes cannot depend on the Worker bundle. Generate or verify its contract data from the shared source and run the same adversarial fixtures against both adapters.
- Enforce the current strict behavior: 10,000-review input cap, 400-character summary, at most three representative review IDs, exact one-time assignment, and existing enum values.

### One-way workflow artifact

- Replace the 1,500-line self-patcher with an independent template and external Code-node sources.
- A small packer reads the template and source files and writes `n8n/workflow.supabase-only.json`.
- `--check` regenerates in memory and fails when the deployment artifact differs.
- Preserve node IDs, positions, versions, connections, portable export metadata, webhook/poll triggers, heartbeat fencing, timeout settings, and credential-free export behavior.

### Clean fresh-install schema

- Keep every existing migration unchanged.
- Generate a deterministic, clean public-schema snapshot from the final database catalog or an equivalent canonical assembly process.
- Exclude historical data backfills and superseded function bodies from the fresh-install artifact while preserving final tables, constraints, indexes, RLS, policies, grants, views, triggers, and function signatures.
- Verify two isolated paths: fresh snapshot and historical upgrade. Run the same runtime fixtures and compare the relevant catalog semantics.

### Worker ownership cleanup

- Resolve a known internal route, read its raw body once, authenticate once, and pass an authenticated context to the handler. Unknown routes remain 404 and known invalid signatures remain 401.
- Use constant-time comparison for fixed secret verification without changing the accepted header/HMAC formats.
- Keep public and private review-feed policies separate while sharing query parsing, cursor handling, and execution.
- Compute persisted priority only in the Worker. Remove the workflow copy after proving payload compatibility.
- Retain `job-status` and compatibility routes until live caller evidence supports a separate retirement change.

### Web ownership cleanup

- Runtime-decode successful public report/review/issue payloads before rendering.
- Return and reuse the Worker-canonical report window.
- Compose caller abort with timeout; replace stale-result/remount compensation with a small discriminated resource state where it reduces existing duplicated state.
- Use one effective artwork recovery path: direct trusted metadata URL, canonical Worker proxy, then the existing local fallback. Worker owns upstream retry and cache semantics.
- Preserve routes, keyboard search behavior, pagination, authentication, account deletion, and user-visible messages.

### Tests and documentation

- Replace source-shape assertions with behavior, generated-artifact equality, build-output, or runtime checks where an external oracle exists.
- Keep narrow construction checks only for security boundaries that are themselves a source contract.
- Correct n8n's documented role, document the combined retry/recovery semantics, and state which layer owns each status, limit, and fallback.

## Deployment and recovery

1. Verify the complete local suite, independent database paths, workflow artifact, Worker dry-run, and clean git diff.
2. Resolve the exact VoC Radar Supabase project, then query its migration history, advisors, active job count, and current public health without reading user content. Stop database and pipeline rollout if the target cannot be proven.
3. Keep n8n stopped while changing internal contracts. Export the existing workflow/volume metadata to operator-private temporary storage before import.
4. If no new database migration exists, do not mutate production SQL; record the migration ledger/catalog check as the database deployment result.
5. Deploy the Worker through a fail-closed wrapper that requires the verified live feature-flag values as explicit CLI overrides and preserves the remaining dashboard variables/secrets. Change `REPORT_V2_ENABLED` only at its explicit database/workflow rollout gate.
6. Import the workflow into the existing n8n volume without duplicating the canonical workflow, reconnect only existing credential references, publish/activate it, and verify health.
7. Run health, public API, SPA deep-link, claim/heartbeat/publish-safe smoke checks that do not leave a queued job or publish test data.
8. Retain or enable `REPORT_V2_ENABLED=true` only if the database, workflow, and public smoke checks pass; do not lower an already verified live value merely because code was redeployed.
9. Push the verified branch and open a draft PR. Record commit SHA, Worker version, workflow ID/version, and every executed check.

Worker recovery uses the post-secret-rotation, pre-code-deploy Worker version. A workflow failure leaves V2 at its last verified value, unpublishes the new workflow version, and restores the operator-private export against the same n8n volume. Additive database objects are not dropped. Secret rotation is coordinated between Worker and n8n and never prints values.

## Acceptance criteria

- One cluster contract change reaches Worker and Node verification; n8n parity is proven by shared fixtures. A 401-500 character summary and four representative IDs produce the same normalized result at both executable boundaries.
- A manual mutation of the generated workflow artifact fails `--check`; regenerating from independent source restores it.
- Fresh-schema and migration-upgrade databases pass the same runtime fixtures and their relevant catalog contracts are equivalent.
- Internal authentication occurs once per known route, preserves raw-body HMAC verification, and cannot be bypassed by direct handler dispatch.
- Public/private review feeds preserve their authorization and accepted-query differences while sharing mechanics.
- Persisted priority has one Worker implementation, and the generated workflow sends review facts without deriving another persisted value.
- Public success payloads fail at the API boundary with a typed error when malformed; report-dependent calls use the server-returned window.
- Artwork fallback performs no redundant proxy attempt hidden by the same canonical cache key.
- Tests validate behavior or generated artifacts rather than the exact workaround source form wherever an external oracle exists.
- Local source acceptance requires `npm run verify`, `npm run verify:database:runtime`, the deterministic schema/workflow checks, and Worker dry-run. Git publication and each production deployment surface remain separate gates; a blocked exact Supabase target must be reported rather than treated as a failed source implementation.

## Verification commands and evidence

```text
npm run verify
npm run verify:database:runtime
npm run verify:workflow
node scripts/generate-supabase-schema.mjs --check
npm run build:web
npm exec --workspace apps/worker wrangler -- deploy --dry-run --config wrangler.toml
```

Production evidence is collected through the authenticated Supabase connector, Wrangler deployment/version commands, the existing local n8n Docker volume, and HTTPS smoke requests. Tracked repository files are public; deployment receipts and backups containing instance metadata remain operator-private.
