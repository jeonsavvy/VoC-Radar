-- Evaluate auth.uid() once per statement instead of once per row.
drop policy if exists pipeline_jobs_insert_authenticated on public.pipeline_jobs;
create policy pipeline_jobs_insert_authenticated
on public.pipeline_jobs
for insert
to authenticated
with check (requested_by = (select auth.uid()));

drop policy if exists pipeline_jobs_select_own on public.pipeline_jobs;
create policy pipeline_jobs_select_own
on public.pipeline_jobs
for select
to authenticated
using (requested_by = (select auth.uid()));
