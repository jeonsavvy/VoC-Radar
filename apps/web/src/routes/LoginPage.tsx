import { FormEvent, useMemo, useState } from 'react';
import { KeyRound, MailCheck } from 'lucide-react';
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
      navigate('/reviews');
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인 처리 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="로그인"
        title="상세 리뷰와 실행 권한을 확인합니다."
        description="공개 대시보드는 로그인 없이 볼 수 있고, 원문 리뷰와 수집 실행은 인증된 계정에서만 사용할 수 있습니다."
        status={mode === 'signup' ? '회원가입' : '로그인'}
      />

      <div className="grid gap-4 xl:grid-cols-[0.86fr_1.14fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">권한 안내</CardTitle>
            <CardDescription>로그인 후 사용할 수 있는 기능을 간단히 정리했습니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-xl border border-border bg-panel px-4 py-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <KeyRound className="size-4 text-primary" />
                원문 리뷰 / 수집 실행 권한
              </p>
              <p className="mt-2 text-sm text-muted-foreground">문제별 원문 리뷰 조회, 수집 실행, 실행 이력 관리는 로그인 후 사용할 수 있습니다.</p>
            </div>
            <div className="rounded-xl border border-border bg-panel px-4 py-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <MailCheck className="size-4 text-primary" />
                이메일 인증 필요
              </p>
              <p className="mt-2 text-sm text-muted-foreground">회원가입 후 이메일 인증을 마쳐야 상세 화면 접근이 가능합니다.</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-xl">계정 인증</CardTitle>
                <CardDescription>같은 폼에서 로그인과 회원가입을 전환합니다.</CardDescription>
              </div>
              <Badge variant={hasSupabaseConfig ? 'success' : 'destructive'}>
                {hasSupabaseConfig ? '설정 완료' : '설정 필요'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
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
    </div>
  );
}
