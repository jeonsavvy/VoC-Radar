import assert from 'node:assert/strict';
import {
  getAuthErrorMessage,
  requestPasswordReset,
  resendSignupConfirmation,
  signUpWithPassword,
  updatePassword,
  type AuthAction,
} from '@/lib/auth';
import { buildPasswordResetRedirect } from '@/lib/authRedirect';

type AuthTestClient = Record<string, (...args: any[]) => any>;

declare global {
  // Supplied through the test runner's local Supabase boundary.
  var __VOC_AUTH_TEST_CLIENT__: AuthTestClient;
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function installWindow(origin = 'https://voc-radar.example') {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin } },
  });
}

async function main() {
  installWindow();

  await test('signup without a session truthfully requires email verification', async () => {
    let signOutCalls = 0;
    globalThis.__VOC_AUTH_TEST_CLIENT__ = {
      signUp: async () => ({ data: { session: null }, error: null }),
      signOut: async () => {
        signOutCalls += 1;
        return { error: null };
      },
    };

    assert.deepEqual(await signUpWithPassword('new@example.com', 'secret123'), {
      requiresEmailVerification: true,
    });
    assert.equal(signOutCalls, 0);
  });

  await test('signup with a session signs out and returns immediately usable success', async () => {
    const signOutCalls: unknown[] = [];
    globalThis.__VOC_AUTH_TEST_CLIENT__ = {
      signUp: async () => ({ data: { session: { access_token: 'fixture' } }, error: null }),
      signOut: async (options) => {
        signOutCalls.push(options);
        return { error: null };
      },
    };

    assert.deepEqual(await signUpWithPassword('new@example.com', 'secret123'), {
      requiresEmailVerification: false,
    });
    assert.deepEqual(signOutCalls, [{ scope: 'local' }]);
  });

  await test('auth errors are classified only by stable code and never expose raw messages', () => {
    const cases: Array<[string, AuthAction, string]> = [
      ['invalid_credentials', 'login', '이메일 또는 비밀번호를 확인하세요.'],
      ['email_not_confirmed', 'login', '이메일 인증을 완료한 뒤 다시 로그인하세요.'],
      ['weak_password', 'signup', '더 길고 추측하기 어려운 비밀번호를 사용하세요.'],
      ['email_address_invalid', 'signup', '올바른 이메일 주소를 입력하세요.'],
      [
        'email_address_not_authorized',
        'signup',
        '이 이메일 주소로는 인증 메일을 보낼 수 없습니다. 다른 이메일 주소를 사용하거나 관리자에게 문의하세요.',
      ],
      [
        'email_provider_disabled',
        'signup',
        '이메일 계정 기능을 현재 사용할 수 없습니다. 관리자에게 문의하세요.',
      ],
      [
        'signup_disabled',
        'signup',
        '이메일 계정 기능을 현재 사용할 수 없습니다. 관리자에게 문의하세요.',
      ],
      [
        'over_email_send_rate_limit',
        'resend',
        '인증 이메일 요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
      ],
      ['over_request_rate_limit', 'reset-request', '요청이 너무 많습니다. 잠시 후 다시 시도하세요.'],
      [
        'configuration_unavailable',
        'password-update',
        '인증 서비스를 현재 사용할 수 없습니다. 잠시 후 다시 시도하세요.',
      ],
      ['unknown_provider_code', 'login', '로그인에 실패했습니다. 잠시 후 다시 시도하세요.'],
      ['same_password', 'password-update', '현재 비밀번호와 다른 비밀번호를 사용하세요.'],
    ];

    for (const [code, action, expected] of cases) {
      const message = getAuthErrorMessage({ code, message: 'provider-secret-detail' }, action);
      assert.equal(message, expected);
      assert.doesNotMatch(message, /provider-secret-detail/);
    }

    assert.equal(
      getAuthErrorMessage({ message: 'invalid_credentials provider-secret-detail' }, 'login'),
      getAuthErrorMessage(new Error('different raw detail'), 'login'),
    );
    assert.equal(
      getAuthErrorMessage({ name: 'AuthSessionMissingError', message: 'provider-secret-detail' }, 'password-update'),
      '재설정 링크가 만료되었거나 유효하지 않습니다. 새 링크를 요청하세요.',
    );
  });

  await test('password reset redirect stays on the current origin with a sanitized return path', () => {
    assert.equal(
      buildPasswordResetRedirect(
        'https://voc-radar.example',
        '/apps/kr/123456789/overview?tab=issues',
      ),
      'https://voc-radar.example/reset-password?returnTo=%2Fapps%2Fkr%2F123456789%2Foverview%3Ftab%3Dissues',
    );
    assert.equal(
      buildPasswordResetRedirect('https://voc-radar.example', '//attacker.example'),
      'https://voc-radar.example/reset-password?returnTo=%2Frequests',
    );
  });

  await test('recovery helpers pass safe redirects and update then clear the recovery session', async () => {
    const calls: Array<[string, unknown]> = [];
    globalThis.__VOC_AUTH_TEST_CLIENT__ = {
      resend: async (payload) => {
        calls.push(['resend', payload]);
        return { error: null };
      },
      resetPasswordForEmail: async (email, options) => {
        calls.push(['reset', { email, options }]);
        return { error: null };
      },
      updateUser: async (payload) => {
        calls.push(['update', payload]);
        return { error: null };
      },
      signOut: async () => {
        calls.push(['signOut', null]);
        return { error: null };
      },
    };

    await resendSignupConfirmation('new@example.com', '//attacker.example');
    await requestPasswordReset('new@example.com', '/requests?from=auth');
    await updatePassword('new-secret-123');

    assert.deepEqual(calls, [
      [
        'resend',
        {
          type: 'signup',
          email: 'new@example.com',
          options: { emailRedirectTo: 'https://voc-radar.example/requests' },
        },
      ],
      [
        'reset',
        {
          email: 'new@example.com',
          options: {
            redirectTo:
              'https://voc-radar.example/reset-password?returnTo=%2Frequests%3Ffrom%3Dauth',
          },
        },
      ],
      ['update', { password: 'new-secret-123' }],
      ['signOut', null],
    ]);
  });
}

void main();
