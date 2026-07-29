import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const validatorPath = fileURLToPath(new URL('./validate-deploy-env.mjs', import.meta.url));
const validEnv = {
  ...process.env,
  VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'public-anon-test-key',
};

const validate = (apiBaseUrl) => spawnSync(process.execPath, [validatorPath], {
  encoding: 'utf8',
  env: { ...validEnv, VITE_API_BASE_URL: apiBaseUrl },
});

test('production deploy validation accepts the same-origin API configuration', () => {
  const result = validate('');
  assert.equal(result.status, 0, result.stderr);
});

test('production deploy validation rejects a cross-origin bearer-token destination', () => {
  const result = validate('https://attacker.example');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be blank for the production same-origin Worker build/);
});
