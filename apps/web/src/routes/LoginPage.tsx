import { FormEvent, useMemo, useState } from 'react';
import { KeyRound, MailCheck, ShieldAlert, Sparkles } from 'lucide-react';
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
        throw new Error(
          'Supabase 설정(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)이 필요합니다. Cloudflare Pages > 설정 > 환경 변수에 두 값을 추가하고 재배포하세요.',
        );
      }

      if (mode === 'signup') {
        await signUpWithPassword(email, password);
        setMessage('회원가입이 완료되었습니다. 이메일 인증 링크를 확인한 뒤 로그인하세요.');
        setSearchParams({});
        return;
      }

      await signInWithPassword(email, password);
      await onSignedIn();
      navigate('/reviews');
    } catch (err) {
      setError(err instanceof Error ? err.message : mode === 'signup' ? '회원가입 실패' : '로그인 실패');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Access Control"
        title="상세 리뷰와 분석 요청 권한을 안전하게 엽니다."
        description="Supabase Auth를 기반으로 비공개 리뷰 피드와 파이프라인 제어 권한을 분리했습니다. 이메일 인증이 완료된 계정만 상세 영역에 접근할 수 있습니다."
        status={mode === 'signup' ? 'Sign up' : 'Sign in'}
      />

      <div className="grid gap-4 xl:grid-cols-[0.92fr_1.08fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">권한 가이드</CardTitle>
            <CardDescription>현재 프로젝트의 인증 흐름과 운영상 주의사항입니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-2xl border border-border/70 bg-background/35 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <KeyRound className="size-4 text-primary" />
                Private feed는 인증 토큰이 있어야 열립니다.
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                `/api/private/reviews`, `/api/private/jobs`, `/api/private/jobs/cancel`은 모두 access token이 필요합니다.
              </p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/35 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <MailCheck className="size-4 text-primary" />
                이메일 인증 미완료 계정은 자동 로그아웃됩니다.
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                회원가입 직후 반드시 메일함의 인증 링크를 먼저 눌러주세요.
              </p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/35 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Sparkles className="size-4 text-primary" />
                공개 리포트는 로그인 없이도 확인할 수 있습니다.
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                지표를 먼저 보고, 이상 신호가 보일 때만 로그인해 상세 근거를 읽는 흐름을 권장합니다.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="text-xl">계정 인증</CardTitle>
                <CardDescription>로그인/회원가입 모드를 전환하며 같은 폼을 사용합니다.</CardDescription>
              </div>
              <Badge variant={hasSupabaseConfig ? 'success' : 'destructive'}>
                {hasSupabaseConfig ? 'Supabase ready' : 'Config missing'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <Tabs value={mode} onValueChange={(value) => setSearchParams(value === 'signup' ? { mode: 'signup' } : {})}>
              <TabsList>
                <TabsTrigger value="login">로그인</TabsTrigger>
                <TabsTrigger value="signup">회원가입</TabsTrigger>
              </TabsList>
              <TabsContent value={mode} className="pt-5">
                <form className="grid gap-4" onSubmit={onSubmit}>
                  <div className="space-y-2">
                    <Label htmlFor="auth-email">이메일</Label>
                    <Input
                      id="auth-email"
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="auth-password">비밀번호</Label>
                    <Input
                      id="auth-password"
                      type="password"
                      required
                      autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </div>

                  <Button type="submit" size="lg" disabled={loading}>
                    {loading ? (mode === 'signup' ? '가입 처리 중...' : '로그인 중...') : mode === 'signup' ? '회원가입' : '로그인'}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>

            {message ? (
              <div className="rounded-2xl border border-primary/20 bg-primary/8 p-4 text-sm text-foreground">{message}</div>
            ) : null}

            {error ? (
              <div className="rounded-2xl border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
                {error}
              </div>
            ) : null}

            {!hasSupabaseConfig ? (
              <div className="rounded-2xl border border-warning/25 bg-warning/10 p-4 text-sm text-muted-foreground">
                <p className="flex items-center gap-2 font-semibold text-foreground">
                  <ShieldAlert className="size-4 text-warning" />
                  로그인이 비활성화됨: Supabase 환경변수가 누락되었습니다.
                </p>
                <ul className="mt-3 list-disc space-y-1 pl-5">
                  <li>Cloudflare Pages 프로젝트 → 설정 → 환경 변수</li>
                  <li><code>VITE_SUPABASE_URL</code> 추가</li>
                  <li><code>VITE_SUPABASE_ANON_KEY</code> 추가</li>
                  <li>저장 후 재배포</li>
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
