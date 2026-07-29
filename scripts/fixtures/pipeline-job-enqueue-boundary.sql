insert into auth.users (id)
values ('11111111-1111-4111-8111-111111111111');

set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
set role authenticated;

do $$
declare
  direct_insert_denied boolean := false;
begin
  begin
    insert into public.pipeline_jobs (
      app_store_id, country, status, stage, attempt_count, requested_by
    ) values (
      'runtime-direct-attacker', 'kr', 'queued', 'queued', 3,
      '11111111-1111-4111-8111-111111111111'
    );
  exception when insufficient_privilege then
    direct_insert_denied := true;
  end;

  if not direct_insert_denied then
    raise exception 'authenticated direct pipeline job insert unexpectedly succeeded';
  end if;
end;
$$;

reset role;
reset request.jwt.claim.sub;

set role service_role;

insert into public.pipeline_jobs (
  app_store_id, country, status, stage, requested_by
) values (
  'runtime-worker-enqueue', 'kr', 'queued', 'queued',
  '11111111-1111-4111-8111-111111111111'
);

reset role;

do $$
begin
  if exists (
    select 1 from public.pipeline_jobs where app_store_id = 'runtime-direct-attacker'
  ) then
    raise exception 'denied direct insert left a pipeline job behind';
  end if;

  if not exists (
    select 1
    from public.pipeline_jobs
    where app_store_id = 'runtime-worker-enqueue'
      and requested_by = '11111111-1111-4111-8111-111111111111'
      and status = 'queued'
      and stage = 'queued'
      and attempt_count = 0
  ) then
    raise exception 'service-role enqueue contract was not preserved';
  end if;
end;
$$;

delete from public.pipeline_jobs where app_store_id = 'runtime-worker-enqueue';
delete from auth.users where id = '11111111-1111-4111-8111-111111111111';
