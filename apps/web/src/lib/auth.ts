import { hasSupabaseConfig, supabase } from './supabase';
import {
  buildEmailSignUpCredentials,
  buildPasswordResetRedirect,
  sanitizeAuthReturnTo,
} from './authRedirect';

export type AuthAction =
  | 'login'
  | 'signup'
  | 'resend'
  | 'reset-request'
  | 'password-update';

export type SignUpResult = {
  requiresEmailVerification: boolean;
};

const UNKNOWN_AUTH_MESSAGES: Record<AuthAction, string> = {
  login: '로그인에 실패했습니다. 잠시 후 다시 시도하세요.',
  signup: '회원가입에 실패했습니다. 잠시 후 다시 시도하세요.',
  resend: '인증 이메일을 보내지 못했습니다. 잠시 후 다시 시도하세요.',
  'reset-request': '비밀번호 재설정 이메일을 보내지 못했습니다. 잠시 후 다시 시도하세요.',
  'password-update': '비밀번호를 변경하지 못했습니다. 잠시 후 다시 시도하세요.',
};

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: '이메일 또는 비밀번호를 확인하세요.',
  email_not_confirmed: '이메일 인증을 완료한 뒤 다시 로그인하세요.',
  weak_password: '더 길고 추측하기 어려운 비밀번호를 사용하세요.',
  email_address_invalid: '올바른 이메일 주소를 입력하세요.',
  email_address_not_authorized:
    '이 이메일 주소로는 인증 메일을 보낼 수 없습니다. 다른 이메일 주소를 사용하거나 관리자에게 문의하세요.',
  email_provider_disabled: '이메일 계정 기능을 현재 사용할 수 없습니다. 관리자에게 문의하세요.',
  signup_disabled: '이메일 계정 기능을 현재 사용할 수 없습니다. 관리자에게 문의하세요.',
  over_email_send_rate_limit: '인증 이메일 요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
  over_request_rate_limit: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
  configuration_unavailable: '인증 서비스를 현재 사용할 수 없습니다. 잠시 후 다시 시도하세요.',
  auth_configuration_unavailable: '인증 서비스를 현재 사용할 수 없습니다. 잠시 후 다시 시도하세요.',
  session_not_found: '재설정 링크가 만료되었거나 유효하지 않습니다. 새 링크를 요청하세요.',
  session_expired: '재설정 링크가 만료되었거나 유효하지 않습니다. 새 링크를 요청하세요.',
  flow_state_expired: '재설정 링크가 만료되었거나 유효하지 않습니다. 새 링크를 요청하세요.',
  otp_expired: '재설정 링크가 만료되었거나 유효하지 않습니다. 새 링크를 요청하세요.',
  same_password: '현재 비밀번호와 다른 비밀번호를 사용하세요.',
};

const AUTH_ERROR_NAMES: Record<string, string> = {
  AuthSessionMissingError: 'session_not_found',
};

function getAuthErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') {
    return null;
  }

  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }

  if ('name' in error && typeof error.name === 'string') {
    return AUTH_ERROR_NAMES[error.name] ?? null;
  }

  return null;
}

function createAuthError(code: string) {
  return Object.assign(new Error('Authentication request failed.'), { code });
}

function requireAuthClient() {
  if (!hasSupabaseConfig || !supabase) {
    throw createAuthError('configuration_unavailable');
  }

  return supabase.auth;
}

export function getAuthErrorMessage(error: unknown, action: AuthAction): string {
  const code = getAuthErrorCode(error);
  return (code && AUTH_ERROR_MESSAGES[code]) || UNKNOWN_AUTH_MESSAGES[action];
}

export function validateSignupPasswords(password: string, confirmPassword: string) {
  return password === confirmPassword ? null : '비밀번호가 일치하지 않습니다.';
}

// auth.ts는 Web에서 사용하는 이메일 기반 인증 동작만 모아둔 파일이다.
// 로그인/회원가입 후 추가 화면 분기 없이 바로 사용할 수 있는 상태인지 확인한다.
export async function signInWithPassword(email: string, password: string) {
  const auth = requireAuthClient();

  const { error } = await auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    throw error;
  }

  const {
    data: { user },
    error: userError,
  } = await auth.getUser();

  if (userError) {
    throw userError;
  }

  if (!user?.email_confirmed_at) {
    const { error: signOutError } = await auth.signOut();
    if (signOutError) {
      throw signOutError;
    }
    throw createAuthError('email_not_confirmed');
  }
}

// 회원가입은 계정을 생성하고, 이메일 확인이 끝나야 실제 로그인 단계로 넘어가게 한다.
export async function signUpWithPassword(
  email: string,
  password: string,
  returnTo = '/requests',
): Promise<SignUpResult> {
  const auth = requireAuthClient();

  const { data, error } = await auth.signUp(
    buildEmailSignUpCredentials(email, password, window.location.origin, returnTo),
  );

  if (error) {
    throw error;
  }

  if (data.session) {
    const { error: signOutError } = await auth.signOut({ scope: 'local' });
    if (signOutError) {
      throw signOutError;
    }
    return {
      requiresEmailVerification: false,
    };
  }

  return {
    requiresEmailVerification: true,
  };
}

export async function signOut() {
  if (!supabase) {
    return;
  }

  const { error } = await supabase.auth.signOut();
  if (error) {
    throw error;
  }
}

// 계정 삭제는 서버 세션을 폐기한 뒤에도 이 기기에 남은 토큰을 별도로 정리해야 한다.
export async function clearLocalSession() {
  if (!supabase) {
    throw new Error('로컬 세션을 정리할 수 없습니다.');
  }

  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) {
    throw error;
  }
}

// 비공개 API 호출 전 현재 세션의 access token을 가져온다.
export async function getAccessToken(): Promise<string | null> {
  if (!supabase) {
    return null;
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  return session?.access_token ?? null;
}

export async function getSessionSummary() {
  if (!supabase) {
    return { loggedIn: false, userEmail: null };
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  return {
    loggedIn: Boolean(session?.access_token),
    userEmail: session?.user?.email ?? null,
  };
}

export async function resendSignupConfirmation(email: string, returnTo = '/requests') {
  const auth = requireAuthClient();
  const { error } = await auth.resend({
    type: 'signup',
    email,
    options: {
      emailRedirectTo: new URL(sanitizeAuthReturnTo(returnTo), window.location.origin).toString(),
    },
  });

  if (error) {
    throw error;
  }
}

export async function requestPasswordReset(email: string, returnTo = '/requests') {
  const auth = requireAuthClient();
  const { error } = await auth.resetPasswordForEmail(email, {
    redirectTo: buildPasswordResetRedirect(window.location.origin, returnTo),
  });

  if (error) {
    throw error;
  }
}

export async function updatePassword(password: string) {
  const auth = requireAuthClient();
  const { error } = await auth.updateUser({ password });
  if (error) {
    throw error;
  }

  const { error: signOutError } = await auth.signOut();
  if (signOutError) {
    throw signOutError;
  }
}

export function subscribeToAuthChanges(onChange: () => void) {
  if (!supabase) {
    return () => {};
  }

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange(onChange);

  return () => subscription.unsubscribe();
}
