import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Shell } from '@/components/Shell';
import { formatCreateJobMessage } from '@/routes/AnalyzePage';
import * as LoginPageModule from '@/routes/LoginPage';
import { LoginPage } from '@/routes/LoginPage';
import { PrivacyPage } from '@/routes/PrivacyPage';

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main() {
  await test('Shell shows the signed-in account label next to the logout action', () => {
    const ShellWithLooseProps = Shell as unknown as (props: Record<string, unknown>) => any;

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <ShellWithLooseProps
                loggedIn={true}
                userEmail="owner@example.com"
                onSignOut={() => {}}
                selection={{
                  appId: '123456789',
                  country: 'kr',
                }}
                onSelectionChange={() => {}}
              />
            }
          >
            <Route index element={<div>child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    assert.match(html, /owner@example\.com/);
    assert.match(html, /로그아웃/);
    assert.match(html, /계정 탈퇴/);
    assert.match(html, /개인정보처리방침/);
    assert.match(html, /href="\/privacy"/);
  });

  await test('PrivacyPage renders as a standalone public page with return navigation', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );

    assert.match(html, /개인정보처리자/);
    assert.match(html, /전찬혁/);
    assert.match(html, /jeonsavvy@gmail\.com/);
    assert.match(html, /2026년 3월 1일/);
    assert.match(html, /대시보드로 돌아가기/);
    assert.match(html, /href="\/"/);
    assert.doesNotMatch(html, /App Store ID를 직접 입력/);
  });

  await test('API client keeps a production Worker fallback when Pages build env is missing', () => {
    const source = readFileSync('src/lib/api.ts', 'utf8');

    assert.match(source, /DEFAULT_PRODUCTION_API_BASE_URL/);
    assert.match(source, /https:\/\/voc-radar-api\.jeonsavvy\.workers\.dev/);
    assert.match(source, /import\.meta\.env\.PROD/);
  });

  await test('App keeps privacy route outside the dashboard shell', () => {
    const source = readFileSync('src/App.tsx', 'utf8');
    const privacyRouteIndex = source.indexOf('path="/privacy"');
    const shellRouteIndex = source.indexOf('<Shell');

    assert.ok(privacyRouteIndex > -1, 'privacy route should be registered');
    assert.ok(shellRouteIndex > -1, 'dashboard shell should still be registered');
    assert.ok(privacyRouteIndex < shellRouteIndex, 'privacy route should be a sibling before the shell route');
    assert.doesNotMatch(source.slice(shellRouteIndex), /path="privacy"/);
  });

  await test('LoginPage shows a password confirmation field in signup mode', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/login?mode=signup']}>
        <LoginPage onSignedIn={async () => {}} />
      </MemoryRouter>,
    );

    assert.match(html, /비밀번호 재확인/);
  });

  await test('LoginPage exports signup password confirmation validation', () => {
    const validateSignupPasswords = (LoginPageModule as Record<string, unknown>).validateSignupPasswords;
    assert.equal(typeof validateSignupPasswords, 'function');

    assert.equal(
      (validateSignupPasswords as (password: string, confirmPassword: string) => string | null)('secret123', 'secret321'),
      '비밀번호가 일치하지 않습니다.',
    );
    assert.equal(
      (validateSignupPasswords as (password: string, confirmPassword: string) => string | null)('secret123', 'secret123'),
      null,
    );
  });

  await test('AnalyzePage surfaces an unconfigured n8n trigger after job creation', () => {
    const message = formatCreateJobMessage({
      ok: true,
      data: {
        id: 'job-1',
        app_store_id: '123456789',
        country: 'kr',
        app_name: null,
        source: 'web',
        status: 'queued',
        run_id: null,
        note: null,
        error_message: null,
        requested_at: '2026-05-01T00:00:00.000Z',
        started_at: null,
        finished_at: null,
        created_at: '2026-05-01T00:00:00.000Z',
        updated_at: '2026-05-01T00:00:00.000Z',
      },
      trigger: {
        dispatched: false,
        reason: 'trigger_webhook_not_configured',
      },
    });

    assert.match(message, /수집 요청이 등록되었습니다/);
    assert.match(message, /N8N_PIPELINE_TRIGGER_URL/);
    assert.match(message, /queued/);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
