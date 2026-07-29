import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const containerName = `voc-radar-db-verify-${randomUUID().slice(0, 8)}`;
const repositoryRoot = process.cwd();
let containerCreated = false;

function docker(args, { input, allowFailure = false, timeout } = {}) {
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 8 * 1024 * 1024,
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
  let consecutiveReadyProbes = 0;
  const readyDeadline = Date.now() + 30_000;
  // The official image briefly starts an initialization server before PID 1
  // becomes the final postmaster. Require that transition plus stable SQL probes.
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
    if (consecutiveReadyProbes >= 3) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    throw new Error('temporary PostgreSQL did not become ready');
  }

  runSqlFile('scripts/fixtures/supabase-postgres-shim.sql');
  runSqlFile('supabase/schema.sql');
  runSqlFile('supabase/migrations/202607260001_pipeline_stabilization.sql');
  runSqlFile('supabase/migrations/202607270001_pipeline_stabilization_runtime_fixes.sql');
  runSqlFile('scripts/fixtures/pipeline-job-enqueue-legacy-state.sql');
  runSqlFile('supabase/migrations/202607290001_prepare_pipeline_job_enqueue.sql');
  runSqlFile('scripts/fixtures/pipeline-job-enqueue-prepare.sql');
  runSqlFile('scripts/fixtures/account-privacy-legacy-state.sql');
  runSqlFile('supabase/migrations/202607290002_finalize_account_privacy_and_public_apps.sql');
  runSqlFile('supabase/migrations/202607290003_harden_pipeline_job_enqueue.sql');
  runSqlFile('scripts/fixtures/pipeline-job-enqueue-boundary.sql');
  runSqlFile('supabase/migrations/202607290004_scope_issue_reads_to_requested_window.sql');
  runSqlFile('supabase/migrations/202607290005_enforce_pipeline_stage_monotonicity.sql');
  runSqlFile('supabase/migrations/202607290006_bound_pipeline_review_scope_lookup.sql');
  runSqlFile('supabase/migrations/202607290007_bound_pipeline_cluster_context.sql');
  runSqlFile('supabase/migrations/202607290008_bound_pipeline_persistence_inputs.sql');
  runSqlFile('scripts/fixtures/account-privacy-runtime.sql');
  runSqlFile('scripts/fixtures/pipeline-runtime-smoke.sql');
  runSqlFile('supabase/tests/public_issue_window_runtime.sql');

  console.log('[postgres-runtime-check] OK');
} finally {
  if (containerCreated) {
    docker(['rm', '-f', containerName], { allowFailure: true });
  }
}
