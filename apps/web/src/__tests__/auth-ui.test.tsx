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

  await test('Explore page presents recent analyses without recommendation commentary', () => {
    const source = readFileSync('src/routes/ExplorePage.tsx', 'utf8');
    assert.match(source, /최근 분석/);
    assert.doesNotMatch(source, /고정 추천|실제 분석|필수 앱|추천 앱|APP DIRECTORY|PUBLIC REPORTS/);
  });

  await test('App registers public report and request-history routes', () => {
    const source = readFileSync('src/App.tsx', 'utf8');
    assert.match(source, /path="apps\/:country\/:appId\/:tab"/);
    assert.match(source, /Navigate to="overview"/);
    assert.match(source, /path="requests"/);
    assert.match(source, /path="privacy"/);
  });

  await test('public entry defers private routes and authentication dependencies', () => {
    const appSource = readFileSync('src/App.tsx', 'utf8');
    const styles = readFileSync('src/styles.css', 'utf8');
    const headers = readFileSync('public/_headers', 'utf8');
    const search = readFileSync('src/components/GlobalSearch.tsx', 'utf8');

    assert.match(appSource, /lazy\(\(\) =>\s*import\('@\/routes\/AppReportPage'\)/);
    assert.match(appSource, /await import\('@\/lib\/auth'\)/);
    assert.doesNotMatch(appSource, /from '@\/lib\/(?:auth|supabase)'/);
    assert.doesNotMatch(styles, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
    assert.match(styles, /--font-sans: system-ui/);
    assert.match(headers, /\/assets\/\*[\s\S]*Cache-Control: public, max-age=31556952, immutable/);
    assert.match(search, /role="combobox"/);
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
    assert.equal(reportPath('123456789', 'kr'), '/apps/kr/123456789/overview');
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

  await test('user-facing routes omit portfolio-style explanatory labels', () => {
    const source = [
      'src/routes/ExplorePage.tsx',
      'src/routes/AppReportPage.tsx',
      'src/routes/RequestsPage.tsx',
      'src/routes/LoginPage.tsx',
      'src/routes/PrivacyPage.tsx',
      'src/lib/api.ts',
      'src/lib/auth.ts',
    ].map((path) => readFileSync(path, 'utf8')).join('\n');

    assert.doesNotMatch(source, /APP DIRECTORY|PUBLIC REPORTS|MY ANALYSIS REQUESTS|NO ANALYSIS YET/);
    assert.doesNotMatch(source, /고정 추천이 아니라|리포트 열람은 공개되며|요청이 게시되기까지의 처리 상태를 확인합니다/);
    assert.doesNotMatch(source, /Supabase 환경변수|Supabase Dashboard|Worker\/API 상태를 확인|VITE_SUPABASE_URL \/ VITE_SUPABASE_ANON_KEY/);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
