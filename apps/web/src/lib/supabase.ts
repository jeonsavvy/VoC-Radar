import { createClient } from '@supabase/supabase-js';

// Supabase 클라이언트는 Web 인증과 세션 조회에만 사용한다.
// 환경변수가 없으면 null을 반환해 로그인 기능을 명시적으로 비활성화한다.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = hasSupabaseConfig
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
