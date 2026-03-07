import { FormEvent, useMemo, useState } from 'react';
import { MailCheck } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { signInWithPassword, signUpWithPassword } from '@/lib/auth';
import { hasSupabaseConfig } from '@/lib/supabase';

type Props = {
  onSignedIn: () => Promise<void>;
};

export function LoginPage({ onSignedIn }: Props) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = useMemo(() => (searchParams.get('mode') === 'signup' ? 'signup' : 'login'), [searchParams]);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    setError(null);
    setLoading(true);

    try {
      if (!hasSupabaseConfig) {
        throw new Error('Supabase 환경변수가 없어 로그인을 사용할 수 없습니다. Pages 환경변수를 먼저 설정하세요.');
      }

      if (mode === 'signup') {
        await signUpWithPassword(email, password);
        setMessage('회원가입이 완료되었습니다. 이메일 인증 후 로그인하세요.');
        setSearchParams({});
        return;
      }

      await signInWithPassword(email, password);
      await onSignedIn();
      navigate('/analyze');
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인 처리 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="수집 실행 로그인" description="원문 리뷰는 공개되어 있습니다. 수집 실행과 실행 이력 확인만 로그인 후 사용할 수 있습니다." />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-xl">계정 인증</CardTitle>
              <CardDescription>수집 실행을 위해 로그인하거나 계정을 만듭니다.</CardDescription>
            </div>
            <Badge variant={hasSupabaseConfig ? 'success' : 'destructive'}>
              {hasSupabaseConfig ? '설정 완료' : '설정 필요'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-xl border border-border bg-panel px-4 py-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <MailCheck className="size-4 text-primary" />
              이메일 인증 필요
            </p>
            <p className="mt-2 text-sm text-muted-foreground">회원가입 후 이메일 인증을 마쳐야 수집 실행을 사용할 수 있습니다.</p>
          </div>

          <Tabs value={mode} onValueChange={(value) => setSearchParams(value === 'signup' ? { mode: 'signup' } : {})}>
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

                <Button type="submit" size="lg" className="w-full" disabled={loading}>
                  {loading ? (mode === 'signup' ? '회원가입 처리 중...' : '로그인 중...') : mode === 'signup' ? '회원가입' : '로그인'}
                </Button>
              </form>
            </TabsContent>
          </Tabs>

          {message ? <div className="rounded-xl border border-primary/20 bg-primary/8 px-4 py-3 text-sm text-foreground">{message}</div> : null}
          {error ? <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div> : null}
        </CardContent>
      </Card>
    </div>
  );
}
