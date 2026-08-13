import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workerRoot = resolve(repositoryRoot, 'apps/worker');
const booleanFlagNames = ['REPORT_V2_ENABLED', 'DETAIL_VIEW_ENABLED'];

export function resolveDeploymentFlags(env = process.env) {
  return Object.fromEntries(booleanFlagNames.map((name) => {
    const value = String(env[name] || '').trim().toLowerCase();
    if (value !== 'true' && value !== 'false') {
      throw new Error(`${name} must be explicitly set to true or false for deployment.`);
    }
    return [name, value];
  }));
}

export function buildWranglerDeployArgs(env = process.env, { dryRun = false } = {}) {
  const flags = resolveDeploymentFlags(env);
  const args = [
    'deploy',
    '--config',
    'wrangler.toml',
    '--keep-vars',
    '--var',
    `REPORT_V2_ENABLED:${flags.REPORT_V2_ENABLED}`,
    '--var',
    `DETAIL_VIEW_ENABLED:${flags.DETAIL_VIEW_ENABLED}`,
  ];
  if (dryRun) args.push('--dry-run');
  return args;
}

function run() {
  const unsupportedArgs = process.argv.slice(2).filter((arg) => arg !== '--dry-run');
  if (unsupportedArgs.length > 0) {
    throw new Error(`unsupported deploy arguments: ${unsupportedArgs.join(', ')}`);
  }

  const requireFromWorker = createRequire(new URL('../apps/worker/package.json', import.meta.url));
  const wranglerPackage = requireFromWorker.resolve('wrangler/package.json');
  const wranglerBin = resolve(dirname(wranglerPackage), 'bin/wrangler.js');
  const args = buildWranglerDeployArgs(process.env, {
    dryRun: process.argv.includes('--dry-run'),
  });
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd: workerRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
