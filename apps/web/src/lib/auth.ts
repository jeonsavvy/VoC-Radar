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

  return {
    hasSession: Boolean(data.session?.access_token),
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
