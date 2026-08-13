import assert from 'node:assert/strict';
import {
  createDatabase,
  prepareSupabaseDatabase,
  replayMigrations,
  runSql,
  runSqlFile,
  startPostgres,
  stopPostgres,
} from './postgres-schema-tools.mjs';

const databases = {
  fresh: 'fresh_path',
  upgrade: 'upgrade_path',
};

const catalogQueries = {
  functions: `
    select concat_ws(E'\\t',
      p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
      p.prokind,
      l.lanname,
      p.prosecdef,
      p.provolatile,
      p.proisstrict,
      coalesce(array_to_string(p.proconfig, ','), ''),
      pg_get_function_arguments(p.oid),
      pg_get_function_result(p.oid),
      md5(replace(p.prosrc, chr(13) || chr(10), chr(10))))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    left join pg_depend d
      on d.classid = 'pg_proc'::regclass
      and d.objid = p.oid
      and d.deptype = 'e'
    where n.nspname = 'public' and d.objid is null
    order by 1`,
  relations: `
    select concat_ws(E'\\t',
      c.relkind,
      c.relname,
      a.attnum,
      a.attname,
      pg_catalog.format_type(a.atttypid, a.atttypmod),
      a.attnotnull,
      coalesce(pg_get_expr(ad.adbin, ad.adrelid), ''),
      a.attidentity,
      a.attgenerated,
      coalesce(array_to_string(c.reloptions, ','), ''))
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef ad on ad.adrelid = c.oid and ad.adnum = a.attnum
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
    order by c.relkind, c.relname, a.attnum`,
  constraints: `
    select concat_ws(E'\\t',
      c.relname,
      con.conname,
      con.contype,
      con.convalidated,
      con.condeferrable,
      con.condeferred,
      pg_get_constraintdef(con.oid, true))
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
    order by c.relname, con.conname`,
  indexes: `
    select concat_ws(E'\\t',
      table_class.relname,
      index_class.relname,
      idx.indisunique,
      idx.indisprimary,
      idx.indisvalid,
      pg_get_indexdef(idx.indexrelid))
    from pg_index idx
    join pg_class index_class on index_class.oid = idx.indexrelid
    join pg_class table_class on table_class.oid = idx.indrelid
    join pg_namespace n on n.oid = table_class.relnamespace
    where n.nspname = 'public'
    order by table_class.relname, index_class.relname`,
  rls_and_policies: `
    with rls as (
      select 'RLS' as kind, c.relname as object_name,
        concat_ws(E'\\t', c.relrowsecurity, c.relforcerowsecurity) as definition
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
    ), policies as (
      select 'POLICY', c.relname, concat_ws(E'\\t',
        pol.polname,
        pol.polpermissive,
        pol.polcmd,
        coalesce((select string_agg(pg_get_userbyid(role_id), ',' order by pg_get_userbyid(role_id))
          from unnest(pol.polroles) role_id), ''),
        coalesce(pg_get_expr(pol.polqual, pol.polrelid), ''),
        coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''))
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
    )
    select concat_ws(E'\\t', kind, object_name, definition)
    from (select * from rls union all select * from policies) catalog
    order by kind, object_name, definition`,
  grants: `
    with relation_grants as (
      select c.relkind::text as kind, c.relname as object_name,
        coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC') as grantee,
        acl.privilege_type, acl.is_grantable
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault(
        case when c.relkind = 'S' then 'S'::"char" else 'r'::"char" end, c.relowner))) acl
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
    ), function_grants as (
      select 'f' as kind,
        p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as object_name,
        coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC') as grantee,
        acl.privilege_type, acl.is_grantable
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      left join pg_depend d
        on d.classid = 'pg_proc'::regclass
        and d.objid = p.oid
        and d.deptype = 'e'
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) acl
      where n.nspname = 'public' and d.objid is null
    )
    select concat_ws(E'\\t', kind, object_name, grantee, privilege_type, is_grantable)
    from (select * from relation_grants union all select * from function_grants) catalog
    order by kind, object_name, grantee, privilege_type`,
  views_and_triggers: `
    with views as (
      select 'VIEW' as kind, c.relname as object_name,
        concat_ws(E'\\t', coalesce(array_to_string(c.reloptions, ','), ''), md5(pg_get_viewdef(c.oid, true))) as definition
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm')
    ), triggers as (
      select 'TRIGGER', c.relname || '.' || t.tgname,
        concat_ws(E'\\t', t.tgenabled, pg_get_triggerdef(t.oid, true))
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal
    )
    select concat_ws(E'\\t', kind, object_name, definition)
    from (select * from views union all select * from triggers) catalog
    order by kind, object_name`,
};

const semanticFixtures = [
  'scripts/fixtures/account-privacy-runtime.sql',
  'scripts/fixtures/pipeline-runtime-smoke.sql',
  'supabase/tests/public_issue_window_runtime.sql',
];

const serviceOnlyFunctions = [
  'cancel_pipeline_jobs',
  'claim_pipeline_job',
  'complete_pipeline_job',
  'enqueue_pipeline_job',
  'get_existing_review_ids',
  'get_pipeline_cluster_context',
  'get_pipeline_cluster_context_v2',
  'get_pipeline_review_scope',
  'get_public_apps',
  'get_public_issue_clusters',
  'get_public_issue_clusters_windowed',
  'get_public_issue_detail',
  'get_public_issue_detail_windowed',
  'persist_issue_clusters',
  'persist_pipeline_alerts',
  'persist_pipeline_reviews',
  'prepare_account_deletion',
  'publish_pipeline_run',
  'record_pipeline_parse_error',
  'renew_pipeline_job_claim',
];

function compareCatalog(containerName) {
  for (const [section, query] of Object.entries(catalogQueries)) {
    const fresh = runSql(containerName, databases.fresh, query).trim();
    const upgrade = runSql(containerName, databases.upgrade, query).trim();
    assert.equal(fresh, upgrade, `${section} catalog differs between fresh and upgrade paths`);
    const count = fresh === '' ? 0 : fresh.split('\n').length;
    console.log(`[postgres-runtime-check] catalog ${section}: ${count} rows`);
  }
}

function runSemanticFixtures(containerName, pathName, databaseName) {
  for (const fixture of semanticFixtures) {
    runSqlFile(containerName, databaseName, fixture);
    console.log(`[postgres-runtime-check] ${pathName} fixture: ${fixture} OK`);
  }
}

function assertServiceOnlyFunctionPrivileges(containerName, pathName, databaseName) {
  const quotedNames = serviceOnlyFunctions.map((name) => `'${name}'`).join(', ');
  const privileges = runSql(containerName, databaseName, `
    select concat_ws(E'\\t',
      p.proname,
      has_function_privilege('anon', p.oid, 'EXECUTE'),
      has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      has_function_privilege('service_role', p.oid, 'EXECUTE'))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (${quotedNames})
    order by p.proname
  `).trim().split('\n').filter(Boolean);

  assert.equal(privileges.length, serviceOnlyFunctions.length, `${pathName} service-only RPC count differs`);
  for (const privilege of privileges) {
    const [functionName, anon, authenticated, serviceRole] = privilege.split('\t');
    assert.deepEqual(
      { anon, authenticated, serviceRole },
      { anon: 'f', authenticated: 'f', serviceRole: 't' },
      `${pathName} exposes service-only RPC ${functionName}`,
    );
  }
  console.log(`[postgres-runtime-check] ${pathName} service-only RPC ACLs: ${privileges.length} closed`);
}

let containerName;
try {
  containerName = await startPostgres('voc-radar-db-verify');
  createDatabase(containerName, databases.fresh);
  createDatabase(containerName, databases.upgrade);

  prepareSupabaseDatabase(containerName, databases.fresh, { preinstallPgcrypto: true });
  runSqlFile(containerName, databases.fresh, 'supabase/tests/legacy_data_api_defaults.sql');
  runSqlFile(containerName, databases.fresh, 'supabase/schema.sql');

  prepareSupabaseDatabase(containerName, databases.upgrade, { preinstallPgcrypto: true });
  replayMigrations(containerName, databases.upgrade);

  compareCatalog(containerName);
  assertServiceOnlyFunctionPrivileges(containerName, 'fresh with automatic Data API defaults', databases.fresh);
  assertServiceOnlyFunctionPrivileges(containerName, 'upgrade', databases.upgrade);
  runSemanticFixtures(containerName, 'fresh', databases.fresh);
  runSemanticFixtures(containerName, 'upgrade', databases.upgrade);

  console.log('[postgres-runtime-check] OK: isolated fresh and upgrade paths are equivalent');
} finally {
  if (containerName) stopPostgres(containerName);
}
