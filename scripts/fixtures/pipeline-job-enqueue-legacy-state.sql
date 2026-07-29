-- Reconstruct the deployed pre-hardening privilege boundary so the runtime
-- check exercises the prepare and contract migrations independently.

revoke insert on table public.pipeline_jobs from service_role;
grant insert on table public.pipeline_jobs to authenticated;

drop policy if exists pipeline_jobs_insert_authenticated on public.pipeline_jobs;
create policy pipeline_jobs_insert_authenticated
on public.pipeline_jobs
for insert
to authenticated
with check (requested_by = (select auth.uid()));
