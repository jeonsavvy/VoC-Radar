import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const containerName = `voc-radar-db-verify-${randomUUID().slice(0, 8)}`;
const repositoryRoot = process.cwd();
let containerCreated = false;

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (!allowFailure && result.status !== 0) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-6000);
    throw new Error(`docker ${args[0]} failed (${result.status})${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

function runSqlFile(path) {
  docker([
    'exec',
    containerName,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-f',
    `/repo/${path.replaceAll('\\', '/')}`,
  ]);
}

try {
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
    'postgres:17',
  ]);
  containerCreated = true;

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = docker(
      ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
      { allowFailure: true },
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    throw new Error('temporary PostgreSQL did not become ready');
  }

  runSqlFile('scripts/fixtures/supabase-postgres-shim.sql');
  runSqlFile('supabase/20260307_voc_radar_bootstrap.sql');
  runSqlFile('supabase/migrations/202607260001_pipeline_stabilization.sql');
  runSqlFile('supabase/migrations/202607270001_pipeline_stabilization_runtime_fixes.sql');
  runSqlFile('scripts/fixtures/pipeline-runtime-smoke.sql');

  console.log('[postgres-runtime-check] OK');
} finally {
  if (containerCreated) {
    docker(['rm', '-f', containerName], { allowFailure: true });
  }
}
