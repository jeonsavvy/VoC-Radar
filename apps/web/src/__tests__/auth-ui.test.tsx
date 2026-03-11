import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Shell } from '@/components/Shell';
import * as LoginPageModule from '@/routes/LoginPage';
import { LoginPage } from '@/routes/LoginPage';

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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
