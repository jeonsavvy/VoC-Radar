import { hasSupabaseConfig, supabase } from './supabase';

export async function signInWithPassword(email: string, password: string) {
  if (!hasSupabaseConfig || !supabase) {
    throw new Error('Supabase 설정(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)이 필요합니다.');
  }

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    throw error;
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    throw userError;
  }

  if (!user?.email_confirmed_at) {
    await supabase.auth.signOut();
    throw new Error('이메일 인증 완료 후 로그인 가능합니다. 메일함의 인증 링크를 먼저 눌러주세요.');
  }
}

export async function signUpWithPassword(email: string, password: string) {
  if (!hasSupabaseConfig || !supabase) {
    throw new Error('Supabase 설정(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)이 필요합니다.');
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) {
    throw error;
  }

  if (data.session?.access_token) {
    await supabase.auth.signOut();
    throw new Error(
      '현재 Supabase Email 인증이 비활성화되어 있습니다. Supabase Dashboard > Authentication > Email 설정에서 Confirm email을 활성화하세요.',
    );
  }

  return {
    requiresEmailVerification: true,
  };
}

export async function signOut() {
  if (!supabase) {
    return;
  }

  await supabase.auth.signOut();
}

export async function getAccessToken(): Promise<string | null> {
  if (!supabase) {
    return null;
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  return session?.access_token ?? null;
}
