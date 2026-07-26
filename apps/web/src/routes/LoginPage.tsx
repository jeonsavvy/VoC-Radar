import { FormEvent, useMemo, useState } from 'react';
import { MailCheck } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { signInWithPassword, signUpWithPassword } from '@/lib/auth';
import { sanitizeAuthReturnTo } from '@/lib/authRedirect';
import { hasSupabaseConfig } from '@/lib/supabase';

// LoginPage는 신규·갱신 분석 요청에 필요한 계정 인증 화면이다.
// 이메일 인증이 끝난 사용자만 분석 요청 기능에 접근할 수 있다.
type Props = {
  onSignedIn: () => Promise<void>;
};

export function validateSignupPasswords(password: string, confirmPassword: string) {
  return password === confirmPassword ? null : '비밀번호가 일치하지 않습니다.';
}

export function LoginPage({ onSignedIn }: Props) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = useMemo(() => (searchParams.get('mode') === 'signup' ? 'signup' : 'login'), [searchParams]);
  const returnTo = useMemo(() => sanitizeAuthReturnTo(searchParams.get('returnTo')), [searchParams]);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 로그인과 회원가입은 같은 폼을 공유하고, mode에 따라 동작만 바꾼다.
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (mode === 'signup') {
      const passwordError = validateSignupPasswords(password, confirmPassword);
      if (passwordError) {
        setError(passwordError);
        return;
      }
    }

    setLoading(true);

    try {
      if (!hasSupabaseConfig) {
        throw new Error('로그인을 사용할 수 없습니다.');
      }

      if (mode === 'signup') {
        await signUpWithPassword(email, password, returnTo);
        setConfirmPassword('');
        setMessage('회원가입이 완료되었습니다. 이메일 인증 후 로그인하세요.');
        setSearchParams(returnTo === '/requests' ? {} : { returnTo });
        return;
      }

      await signInWithPassword(email, password);
      await onSignedIn();
      navigate(returnTo);
    } catch {
      setError(mode === 'signup'
        ? '회원가입 결과를 확인하지 못했습니다. 인증 이메일이 도착했는지 먼저 확인하고, 오지 않았다면 잠시 후 다시 시도하세요.'
        : '로그인하지 못했습니다. 현재 로그인되지 않은 상태입니다. 이메일 인증 여부와 입력 정보를 확인한 뒤 다시 시도하세요.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="로그인" />

      <Card>
        <CardHeader>
          <div>
            <CardTitle className="text-xl">계정</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-xl border border-border bg-panel px-4 py-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <MailCheck className="size-4 text-primary" />
              이메일 인증 필요
            </p>
            <p className="mt-2 text-sm text-muted-foreground">회원가입 후 이메일 인증을 마쳐야 분석을 요청할 수 있습니다.</p>
          </div>

          <Tabs
            value={mode}
            onValueChange={(value) => {
              setMessage(null);
              setError(null);
              setConfirmPassword('');
              const next = new URLSearchParams(searchParams);
              if (value === 'signup') next.set('mode', 'signup');
              else next.delete('mode');
              setSearchParams(next);
            }}
          >
            <TabsList>
              <TabsTrigger value="login">로그인</TabsTrigger>
              <TabsTrigger value="signup">회원가입</TabsTrigger>
            </TabsList>
            <TabsContent value={mode} className="pt-5">
              <form className="grid gap-4" onSubmit={onSubmit}>
                <div className="space-y-2">
                  <Label htmlFor="login-email">이메일</Label>
                  <Input
                    id="login-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="login-password">비밀번호</Label>
                  <Input
                    id="login-password"
                    type="password"
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                </div>
                {mode === 'signup' ? (
                  <div className="space-y-2">
                    <Label htmlFor="signup-password-confirm">비밀번호 재확인</Label>
                    <Input
                      id="signup-password-confirm"
                      type="password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      required={mode === 'signup'}
                    />
                  </div>
                ) : null}

                <Button type="submit" size="lg" className="w-full" disabled={loading}>
                  {loading ? (mode === 'signup' ? '회원가입 처리 중...' : '로그인 중...') : mode === 'signup' ? '회원가입' : '로그인'}
                </Button>
              </form>
            </TabsContent>
          </Tabs>

          {message ? (
            <div aria-live="polite" className="rounded-xl border border-primary/20 bg-primary/8 px-4 py-3 text-sm text-foreground">
              {message}
            </div>
          ) : null}
          {error ? (
            <div aria-live="polite" className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
