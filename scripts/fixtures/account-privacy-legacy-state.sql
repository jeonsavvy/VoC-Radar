-- Seed rows that must be sanitized when migration 002 is applied a second time
-- by the runtime harness.
insert into public.pipeline_jobs (
  id, app_store_id, country, source, status, requested_by, note, error_message, finished_at
) values
  (
    '80000000-0000-4000-8000-000000000001',
    '8000000001', 'kr', 'web', 'failed', null,
    'orphaned deleted-account note', 'legacy provider response with private detail', now()
  ),
  (
    '80000000-0000-4000-8000-000000000002',
    '8000000002', 'kr', 'reanalysis', 'failed', null,
    'operator reanalysis note', 'operator diagnostic retained outside the user surface', now()
  );
