import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const workspaceRoot = process.cwd();
const srcRoot = path.join(workspaceRoot, 'src');
const outDir = path.join(workspaceRoot, '.test-dist');

async function collectTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectTests(resolved);
      }
      if (/\.test\.(ts|tsx)$/.test(entry.name)) {
        return [resolved];
      }
      return [];
    }),
  );

  return files.flat();
}

const testFiles = await collectTests(srcRoot);

if (testFiles.length === 0) {
  console.log('No test files found.');
  process.exit(0);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

let failed = 0;

for (const testFile of testFiles) {
  const relativePath = path.relative(srcRoot, testFile);
  const outfile = path.join(outDir, relativePath).replace(/\.(ts|tsx)$/, '.cjs');
  await mkdir(path.dirname(outfile), { recursive: true });

  const authTestPlugin = {
    name: 'auth-test-client',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^\.\/supabase$/ }, (args) => {
        if (
          relativePath.endsWith('auth-contract.test.ts') &&
          args.importer.endsWith(path.join('lib', 'auth.ts'))
        ) {
          return { path: 'auth-test-client', namespace: 'auth-test-client' };
        }
      });

      buildContext.onLoad({ filter: /.*/, namespace: 'auth-test-client' }, () => ({
        contents: `
          export const hasSupabaseConfig = true;
          export const supabase = {
            auth: new Proxy({}, {
              get(_target, property) {
                return (...args) => globalThis.__VOC_AUTH_TEST_CLIENT__[property](...args);
              },
            }),
          };
        `,
        loader: 'js',
      }));
    },
  };

  await build({
    entryPoints: [testFile],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile,
    jsx: 'automatic',
    target: ['node20'],
    alias: {
      '@': srcRoot,
    },
    plugins: [authTestPlugin],
    external: ['jsdom'],
    define: {
      'import.meta.env': JSON.stringify({
        VITE_DEFAULT_COUNTRY: 'kr',
        VITE_API_BASE_URL: '',
        VITE_API_TIMEOUT_MS: '10000',
        VITE_API_RETRY_COUNT: '2',
        VITE_SUPABASE_URL: '',
        VITE_SUPABASE_ANON_KEY: '',
      }),
    },
    logLevel: 'silent',
  });

  const result = spawnSync(process.execPath, [outfile], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL ${relativePath}`);
    if (result.error) console.error(result.error);
  }
}

if (failed > 0) {
  process.exit(1);
}
