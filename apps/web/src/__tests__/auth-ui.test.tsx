import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { JSDOM } from 'jsdom';
import { AuthSessionBoundary } from '@/App';
import { AppArtwork, getArtworkSources } from '@/components/AppArtwork';
import { Shell } from '@/components/Shell';
import { parseAppIdentity, reportPath } from '@/lib/appIdentity';
import { DEFAULT_COUNTRY, normalizeDefaultCountry } from '@/lib/config';
import {
  buildEmailSignUpCredentials,
  hasSupabaseAuthCallback,
  sanitizeAuthReturnTo,
} from '@/lib/authRedirect';
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
    assert.match(html, /앱 탐색으로 돌아가기/);
    assert.match(html, /href="\/"/);
    assert.doesNotMatch(html, /App Store ID를 직접 입력/);
  });

  await test('HTML metadata uses the official domain while legacy hosting stays runtime-compatible', () => {
    const html = readFileSync('index.html', 'utf8');

    assert.match(html, /rel="canonical" href="https:\/\/voc-radar\.satinode\.com\/"/);
    assert.match(html, /property="og:url" content="https:\/\/voc-radar\.satinode\.com\/"/);
    assert.doesNotMatch(html, /jeonsavvy\.workers\.dev/);
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

  await test('AppArtwork renders App Store artwork with a same-origin recovery path', () => {
    const artwork = renderToStaticMarkup(
      <AppArtwork
        artworkUrl="https://example.test/app.jpg"
        appName="당근"
        appStoreId="1018769995"
        country="kr"
        size="large"
      />,
    );
    const fallback = renderToStaticMarkup(<AppArtwork artworkUrl={null} appName="당근" />);
    const recovered = renderToStaticMarkup(
      <AppArtwork artworkUrl={null} appName="당근" appStoreId="1018769995" country="kr" />,
    );
    const sources = getArtworkSources({
      artworkUrl: 'https://example.test/app.jpg',
      appStoreId: '1018769995',
      country: 'kr',
    });

    assert.match(artwork, /class="app-artwork app-artwork--large"/);
    assert.match(artwork, /src="https:\/\/example\.test\/app\.jpg"/);
    assert.match(fallback, /class="app-initial"/);
    assert.match(fallback, />당</);
    assert.match(recovered, /src="\/api\/public\/artwork\?appId=1018769995&amp;country=kr/);
    assert.equal(sources.length, 3);
    assert.match(sources[1]!, /attempt=0$/);
    assert.match(sources[2]!, /attempt=1$/);
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
    const reportSource = readFileSync('src/routes/AppReportPage.tsx', 'utf8');
    const styles = readFileSync('src/styles.css', 'utf8');
    const headers = readFileSync('public/_headers', 'utf8');
    const search = readFileSync('src/components/GlobalSearch.tsx', 'utf8');

    assert.match(appSource, /lazy\(\(\) =>\s*import\('@\/routes\/AppReportPage'\)/);
    assert.match(appSource, /await import\('@\/lib\/auth'\)/);
    assert.doesNotMatch(appSource, /from '@\/lib\/(?:auth|supabase)'/);
    assert.match(reportSource, /await import\('@\/lib\/auth'\)/);
    assert.doesNotMatch(reportSource, /from '@\/lib\/(?:auth|supabase)'/);
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
    assert.equal(DEFAULT_COUNTRY, 'kr');
    assert.equal(normalizeDefaultCountry(' US '), 'us');
    assert.equal(normalizeDefaultCountry('invalid'), 'kr');
    assert.deepEqual(parseAppIdentity('123456789', 'kr'), { appId: '123456789', country: 'kr' });
    assert.deepEqual(parseAppIdentity('https://apps.apple.com/us/app/example/id987654321', 'kr'), {
      appId: '987654321',
      country: 'us',
    });
    assert.equal(parseAppIdentity('not an id', 'kr'), null);
    assert.equal(reportPath('123456789', 'kr'), '/apps/kr/123456789/overview');
    assert.doesNotMatch(readFileSync('src/lib/appIdentity.ts', 'utf8'), /1234567890/);
    assert.doesNotMatch(readFileSync('src/routes/ExplorePage.tsx', 'utf8'), /discoverApps\('', 'kr'/);
  });

  await test('email signup returns to the current deployment instead of a configured localhost fallback', () => {
    assert.deepEqual(
      buildEmailSignUpCredentials(
        'new-user@example.com',
        'secret123',
        'https://voc-radar.jeonsavvy.workers.dev',
        '/apps/kr/123456789/overview',
      ),
      {
        email: 'new-user@example.com',
        password: 'secret123',
        options: {
          emailRedirectTo: 'https://voc-radar.jeonsavvy.workers.dev/apps/kr/123456789/overview',
        },
      },
    );

    assert.equal(
      buildEmailSignUpCredentials(
        'new-user@example.com',
        'secret123',
        'https://voc-radar.jeonsavvy.workers.dev',
        '//attacker.example',
      ).options.emailRedirectTo,
      'https://voc-radar.jeonsavvy.workers.dev/requests',
    );

    assert.equal(sanitizeAuthReturnTo('/\\attacker.example'), '/requests');
    assert.equal(sanitizeAuthReturnTo('https://attacker.example'), '/requests');
  });

  await test('App recognizes Supabase confirmation callbacks before local session storage exists', () => {
    assert.equal(hasSupabaseAuthCallback({ hash: '#access_token=fixture', search: '' }), true);
    assert.equal(hasSupabaseAuthCallback({ hash: '', search: '?code=fixture' }), true);
    assert.equal(hasSupabaseAuthCallback({ hash: '', search: '?q=review' }), false);

    const appSource = readFileSync('src/App.tsx', 'utf8');
    const authSource = readFileSync('src/lib/auth.ts', 'utf8');
    const loginSource = readFileSync('src/routes/LoginPage.tsx', 'utf8');
    assert.match(appSource, /hasStoredAuthSession\(\) \|\| hasSupabaseAuthCallback\(window\.location\)/);
    assert.match(authSource, /buildEmailSignUpCredentials\(email, password, window\.location\.origin, returnTo\)/);
    assert.match(loginSource, /sanitizeAuthReturnTo\(searchParams\.get\('returnTo'\)\)/);
  });

  await test('session restoration keeps login gates and redirects in a checking state', () => {
    const appSource = readFileSync('src/App.tsx', 'utf8');
    const shellSource = readFileSync('src/components/Shell.tsx', 'utf8');
    const reportSource = readFileSync('src/routes/AppReportPage.tsx', 'utf8');
    const requestsSource = readFileSync('src/routes/RequestsPage.tsx', 'utf8');
    const ShellWithLooseProps = Shell as unknown as (props: Record<string, unknown>) => any;
    const checkingShell = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/requests']}>
        <Routes>
          <Route
            path="/requests"
            element={<ShellWithLooseProps
              loggedIn={false}
              authChecking={true}
              userEmail={null}
              onSignOut={() => {}}
            />}
          />
        </Routes>
      </MemoryRouter>,
    );

    assert.match(appSource, /const \[authChecking, setAuthChecking\]/);
    assert.match(appSource, /finally \{[\s\S]*setAuthChecking\(false\)/);
    assert.match(appSource, /<Shell[^>]+authChecking=\{authChecking\}/);
    assert.match(shellSource, /authChecking \? \(/);
    assert.match(checkingShell, /class="login-link login-link--checking"/);
    assert.match(checkingShell, /aria-label="로그인 상태 확인 중"/);
    assert.doesNotMatch(checkingShell, /href="\/login/);
    assert.match(reportSource, /if \(authChecking \|\| requestInFlight\.current\) return/);
    assert.match(requestsSource, /if \(authChecking\) return <div className="request-loading" role="status">/);
  });

  await test('stored sessions and confirmation callbacks keep the login gate closed until restoration finishes', async () => {
    const keys = [
      'window',
      'document',
      'navigator',
      'location',
      'HTMLElement',
      'Node',
      'Event',
      'MutationObserver',
    ] as const;
    const originalDescriptors = new Map(
      keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    const originalActEnvironment = Object.getOwnPropertyDescriptor(
      globalThis,
      'IS_REACT_ACT_ENVIRONMENT',
    );
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://voc-radar.example/',
    });
    const { window: browserWindow } = dom;
    const globals = {
      window: browserWindow,
      document: browserWindow.document,
      navigator: browserWindow.navigator,
      location: browserWindow.location,
      HTMLElement: browserWindow.HTMLElement,
      Node: browserWindow.Node,
      Event: browserWindow.Event,
      MutationObserver: browserWindow.MutationObserver,
    };
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });

    const runRestoration = async (url: string, storedSession: boolean) => {
      browserWindow.localStorage.clear();
      browserWindow.history.replaceState(null, '', url);
      if (storedSession) {
        browserWindow.localStorage.setItem('sb-fixture-auth-token', '{}');
      }

      let resolveSession!: (value: { loggedIn: boolean; userEmail: string | null }) => void;
      const session = new Promise<{ loggedIn: boolean; userEmail: string | null }>((resolve) => {
        resolveSession = resolve;
      });
      const container = browserWindow.document.createElement('div');
      browserWindow.document.body.append(container);
      const root = createRoot(container as unknown as HTMLElement);

      try {
        await act(async () => {
          root.render(
            <MemoryRouter initialEntries={['/']}>
              <AuthSessionBoundary loadAuthModule={async () => ({
                getSessionSummary: async () => session,
                subscribeToAuthChanges: () => () => {},
                signOut: async () => {},
              })}>
                {({ loggedIn, authChecking, userEmail, signOut }) => <Routes>
                  <Route
                    element={<Shell
                      loggedIn={loggedIn}
                      authChecking={authChecking}
                      userEmail={userEmail}
                      onSignOut={signOut}
                    />}
                  >
                    <Route index element={<div>child</div>} />
                  </Route>
                </Routes>}
              </AuthSessionBoundary>
            </MemoryRouter>,
          );
        });

        assert.ok(container.querySelector('.login-link--checking'));
        assert.equal(container.querySelector('a[href^="/login"]'), null);

        await act(async () => {
          resolveSession({ loggedIn: true, userEmail: 'restored@example.com' });
          await session;
        });

        assert.equal(container.querySelector('.login-link--checking'), null);
        assert.match(container.textContent || '', /restored@example\.com/);
        assert.match(container.textContent || '', /로그아웃/);
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    };

    try {
      await runRestoration('https://voc-radar.example/', true);
      await runRestoration('https://voc-radar.example/?code=fixture', false);
    } finally {
      browserWindow.close();
      for (const key of keys) {
        const descriptor = originalDescriptors.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
      if (originalActEnvironment) {
        Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
      } else {
        delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
      }
    }
  });

  await test('report UI keeps evidence counts and canonical severity while hiding confidence percentages', () => {
    const source = readFileSync('src/routes/AppReportPage.tsx', 'utf8');
    assert.match(source, /근거 리뷰/);
    assert.match(source, /severityLabel/);
    assert.match(source, /changePercent == null/);
    assert.doesNotMatch(source, /confidence/);
    assert.doesNotMatch(source, /마지막 분석 후 24시간이 지났습니다|stale-banner/);
    const css = readFileSync('src/styles.css', 'utf8');
    assert.match(css, /@media \(max-width: 640px\)/);
    assert.match(css, /\.issue-dialog \{ width: 100vw;/);
    assert.doesNotMatch(css, /\.stale-banner/);
  });

  await test('user-facing routes keep product copy concise', () => {
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

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
