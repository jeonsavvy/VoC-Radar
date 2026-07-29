insert into auth.users (id)
values ('11111111-1111-4111-8111-111111111111');

-- The old Worker path must remain available during the expand phase.
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
set role authenticated;

insert into public.pipeline_jobs (
  app_store_id, country, status, stage, requested_by
) values (
  'runtime-legacy-enqueue', 'kr', 'queued', 'queued',
  '11111111-1111-4111-8111-111111111111'
);

reset role;
reset request.jwt.claim.sub;

-- The new Worker path must be available before the contract phase starts.
set role service_role;

do $$
declare
  enqueue_result jsonb;
begin
  enqueue_result := public.enqueue_pipeline_job(
    '7000000100',
    'kr',
    'Runtime Worker Prepare',
    null,
    '11111111-1111-4111-8111-111111111111',
    10
  );

  if enqueue_result ->> 'result' <> 'queued'
    or enqueue_result #>> '{data,app_store_id}' <> '7000000100'
    or enqueue_result #>> '{data,status}' <> 'queued'
    or enqueue_result #>> '{data,stage}' <> 'queued'
    or enqueue_result -> 'data' ? 'requested_by'
    or enqueue_result -> 'data' ? 'claim_token' then
    raise exception 'prepare migration service-role enqueue RPC returned an unsafe contract';
  end if;
end;
$$;

reset role;

do $$
begin
  if not exists (
    select 1
    from public.pipeline_jobs
    where app_store_id = 'runtime-legacy-enqueue'
      and requested_by = '11111111-1111-4111-8111-111111111111'
      and attempt_count = 0
  ) then
    raise exception 'prepare migration broke the legacy authenticated enqueue path';
  end if;

  if not exists (
    select 1
    from public.pipeline_jobs
    where app_store_id = '7000000100'
      and requested_by = '11111111-1111-4111-8111-111111111111'
      and attempt_count = 0
  ) then
    raise exception 'prepare migration did not enable the service-role enqueue path';
  end if;
end;
$$;

delete from public.pipeline_jobs
where app_store_id in ('runtime-legacy-enqueue', '7000000100');
delete from public.apps where app_store_id = '7000000100' and country = 'kr';
delete from auth.users where id = '11111111-1111-4111-8111-111111111111';
