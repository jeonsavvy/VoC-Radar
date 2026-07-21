import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Shell } from '@/components/Shell';
import { parseAppIdentity, reportPath } from '@/lib/appIdentity';
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
    assert.match(html, /분석 요청 내역/);
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
    assert.match(html, /앱 탐색으로 돌아가기/);
    assert.match(html, /href="\/"/);
    assert.doesNotMatch(html, /App Store ID를 직접 입력/);
  });

  await test('API client defaults to same-origin for the unified Worker', () => {
    const source = readFileSync('src/lib/api.ts', 'utf8');

    assert.match(source, /import\.meta\.env\.VITE_API_BASE_URL \|\| ''/);
    assert.match(source, /하나의 Worker/);
    assert.doesNotMatch(source, /DEFAULT_PRODUCTION_API_BASE_URL/);
  });

  await test('Explore page presents inventory as recent public reports, not required examples', () => {
    const source = readFileSync('src/routes/ExplorePage.tsx', 'utf8');
    assert.match(source, /최근 공개 리포트/);
    assert.match(source, /고정 추천이 아니라 실제 분석이 최근 게시된 앱/);
    assert.doesNotMatch(source, /필수 앱|추천 앱/);
  });

  await test('App registers public report and request-history routes', () => {
    const source = readFileSync('src/App.tsx', 'utf8');
    assert.match(source, /path="apps\/:country\/:appId\/:tab"/);
    assert.match(source, /path="requests"/);
    assert.match(source, /path="privacy"/);
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

  await test('app identity accepts numeric ids and App Store URLs without a fake default', () => {
    assert.deepEqual(parseAppIdentity('123456789', 'kr'), { appId: '123456789', country: 'kr' });
    assert.deepEqual(parseAppIdentity('https://apps.apple.com/us/app/example/id987654321', 'kr'), {
      appId: '987654321',
      country: 'us',
    });
    assert.equal(parseAppIdentity('not an id', 'kr'), null);
    assert.equal(reportPath('123456789', 'kr'), '/apps/kr/123456789/issues');
    assert.doesNotMatch(readFileSync('src/lib/appIdentity.ts', 'utf8'), /1234567890/);
  });

  await test('report UI keeps evidence counts and canonical severity while hiding confidence percentages', () => {
    const source = readFileSync('src/routes/AppReportPage.tsx', 'utf8');
    assert.match(source, /근거 리뷰/);
    assert.match(source, /severityLabel/);
    assert.match(source, /changePercent == null/);
    assert.doesNotMatch(source, /confidence/);
    const css = readFileSync('src/styles.css', 'utf8');
    assert.match(css, /@media \(max-width: 640px\)/);
    assert.match(css, /\.issue-dialog \{ width: 100vw;/);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
