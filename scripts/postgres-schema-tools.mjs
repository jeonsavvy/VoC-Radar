import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
export const postgresImage = 'postgres:17';

export const migrationPaths = readdirSync(new URL('../supabase/migrations/', import.meta.url))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => `supabase/migrations/${name}`);

export function docker(args, { input, allowFailure = false, timeout } = {}) {
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });

  if (result.error) {
    if (allowFailure && result.error.code === 'ETIMEDOUT') return result;
    throw result.error;
  }
  if (!allowFailure && result.status !== 0) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-6000);
    throw new Error(`docker ${args[0]} failed (${result.status})${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

export async function startPostgres(prefix) {
  const containerName = `${prefix}-${randomUUID().slice(0, 8)}`;
  docker([
    'run',
    '--rm',
    '-d',
    '--name',
    containerName,
    '--tmpfs',
    '/var/lib/postgresql/data',
    '--mount',
    `type=bind,source=${repositoryRoot},target=/repo,readonly`,
    '-e',
    'POSTGRES_PASSWORD=local-runtime-check',
    postgresImage,
  ]);

  const readyDeadline = Date.now() + 30_000;
  let consecutiveReadyProbes = 0;
  while (Date.now() < readyDeadline) {
    const probe = docker(
      [
        'exec',
        containerName,
        'sh',
        '-ec',
        'test "$(cat /proc/1/comm)" = postgres && exec psql -U postgres -d postgres -Atqc "select 1"',
      ],
      { allowFailure: true, timeout: 2_000 },
    );
    consecutiveReadyProbes = probe.status === 0 ? consecutiveReadyProbes + 1 : 0;
    if (consecutiveReadyProbes >= 3) return containerName;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  docker(['rm', '-f', containerName], { allowFailure: true });
  throw new Error('temporary PostgreSQL did not become ready');
}

export function stopPostgres(containerName) {
  docker(['rm', '-f', containerName], { allowFailure: true });
}

export function createDatabase(containerName, databaseName) {
  docker(['exec', containerName, 'createdb', '-U', 'postgres', databaseName]);
}

export function runSqlFile(containerName, databaseName, path) {
  docker([
    'exec',
    containerName,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    databaseName,
    '-f',
    `/repo/${path.replaceAll('\\', '/')}`,
  ]);
}

export function runSql(containerName, databaseName, sql) {
  return docker([
    'exec',
    containerName,
    'psql',
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    databaseName,
    '-At',
    '-c',
    sql,
  ]).stdout;
}

export function prepareSupabaseDatabase(containerName, databaseName, { preinstallPgcrypto = false } = {}) {
  const rolesExist = runSql(
    containerName,
    databaseName,
    "select count(*) = 3 from pg_roles where rolname in ('anon', 'authenticated', 'service_role');",
  ).trim() === 't';
  runSqlFile(
    containerName,
    databaseName,
    rolesExist
      ? 'supabase/tests/auth_schema_shim.sql'
      : 'scripts/fixtures/supabase-postgres-shim.sql',
  );
  if (preinstallPgcrypto) {
    // Existing Supabase projects provisioned extensions before project-level
    // public-object defaults, so extension functions did not inherit Data API ACLs.
    runSql(containerName, databaseName, 'create extension if not exists pgcrypto;');
  }
}

export function replayMigrations(containerName, databaseName) {
  runSqlFile(containerName, databaseName, 'supabase/tests/legacy_data_api_defaults.sql');
  for (const migrationPath of migrationPaths) {
    runSqlFile(containerName, databaseName, migrationPath);
  }
  runSqlFile(containerName, databaseName, 'supabase/tests/revoked_data_api_defaults.sql');
}

export function dumpPublicSchema(containerName, databaseName) {
  return docker([
    'exec',
    containerName,
    'pg_dump',
    '-U',
    'postgres',
    '-d',
    databaseName,
    '--schema-only',
    '--schema=public',
    '--no-owner',
    '--no-comments',
    '--no-tablespaces',
  ]).stdout;
}
