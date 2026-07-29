-- Contract: apply only after the service-role Worker is deployed and a new
-- queued job has passed the rollout smoke test.

drop policy if exists pipeline_jobs_insert_authenticated on public.pipeline_jobs;
revoke insert on table public.pipeline_jobs from public, anon, authenticated;
