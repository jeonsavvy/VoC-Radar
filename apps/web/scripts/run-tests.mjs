import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
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
    define: {
      'import.meta.env': JSON.stringify({
        VITE_DEFAULT_APP_ID: '1234567890',
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

  try {
    require(outfile);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${relativePath}`);
    console.error(error);
  }
}

if (failed > 0) {
  process.exit(1);
}
