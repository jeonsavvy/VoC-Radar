import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  getAuthErrorMessage,
  requestPasswordReset,
  signInWithPassword,
  signUpWithPassword,
  validateSignupPasswords,
  type AuthAction,
} from '@/lib/auth';
import { sanitizeAuthReturnTo } from '@/lib/authRedirect';

type Props = { onSignedIn: () => Promise<void> };
type AuthMode = 'login' | 'signup';
type AuthView = AuthMode | 'forgot';
type Notice = {
  kind: 'reset-sent' | 'password-updated';
  email?: string;
};

const AUTH_ACTION = {
  login: 'login',
  signup: 'signup',
  resetRequest: 'reset-request',
} satisfies Record<string, AuthAction>;

function getReturnContext(returnTo: string) {
  if (returnTo === '/requests') return '로그인 후 분석 요청 내역으로 이동합니다.';
  if (returnTo.startsWith('/apps/')) return '로그인 후 보던 리포트로 돌아갑니다.';
  return '로그인 후 이전 화면으로 돌아갑니다.';
}

function buildLoginSearch(returnTo: string) {
  const params = new URLSearchParams();
  if (returnTo !== '/requests') params.set('returnTo', returnTo);
  return params;
}

export function LoginPage({ onSignedIn }: Props) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = useMemo<AuthMode>(
    () => (searchParams.get('mode') === 'signup' ? 'signup' : 'login'),
    [searchParams],
  );
  const returnTo = useMemo(() => sanitizeAuthReturnTo(searchParams.get('returnTo')), [searchParams]);
  const [view, setView] = useState<AuthView>(mode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(
    () => (searchParams.get('passwordUpdated') === '1' ? { kind: 'password-updated' } : null),
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<AuthAction | null>(null);
  const confirmInputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const loading = pendingAction !== null;

  useEffect(() => {
    if (!loading && view !== 'forgot') setView(mode);
  }, [loading, mode, view]);

  useEffect(() => {
    if (submitError) errorRef.current?.focus();
  }, [submitError]);

  const setMode = (nextMode: AuthMode) => {
    if (loading) return;
    setView(nextMode);
    setNotice(null);
    setSubmitError(null);
    setConfirmError(null);
    setConfirmPassword('');
    const next = buildLoginSearch(returnTo);
    if (nextMode === 'signup') next.set('mode', 'signup');
    setSearchParams(next);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submittedView = view;
    setNotice(null);
    setSubmitError(null);
    setConfirmError(null);

    if (submittedView === 'signup') {
      const passwordError = validateSignupPasswords(password, confirmPassword);
      if (passwordError) {
        setConfirmError(passwordError);
        requestAnimationFrame(() => confirmInputRef.current?.focus());
        return;
      }
    }

    const action = submittedView === 'login'
      ? AUTH_ACTION.login
      : submittedView === 'signup'
        ? AUTH_ACTION.signup
        : AUTH_ACTION.resetRequest;
    setPendingAction(action);

    try {
      if (submittedView === 'signup') {
        await signUpWithPassword(email, password, returnTo);
        setPassword('');
        setConfirmPassword('');
        await onSignedIn();
        navigate(returnTo);
      } else if (submittedView === 'forgot') {
        await requestPasswordReset(email, returnTo);
        setNotice({ kind: 'reset-sent', email });
      } else {
        await signInWithPassword(email, password);
        await onSignedIn();
        navigate(returnTo);
      }
    } catch (error) {
      setSubmitError(getAuthErrorMessage(error, action));
    } finally {
      setPendingAction(null);
    }
  };

  const heading = view === 'signup' ? '계정 만들기' : view === 'forgot' ? '비밀번호 재설정' : '로그인';
  const description = view === 'signup'
    ? '가입하면 바로 로그인됩니다. 이후 분석을 요청할 수 있습니다.'
    : view === 'forgot'
      ? '재설정 링크를 받을 이메일을 입력하세요.'
      : '분석을 요청하거나 요청 내역을 확인하려면 로그인하세요.';
  const submitLabel = view === 'signup' ? '계정 만들기' : view === 'forgot' ? '재설정 링크 받기' : '로그인';
  const loadingLabel = view === 'signup' ? '계정 만드는 중' : view === 'forgot' ? '링크 보내는 중' : '로그인 중';
  const showForm = notice?.kind !== 'reset-sent';

  return (
    <div className="auth-page">
      <section className="auth-panel" aria-labelledby="auth-title">
        {view !== 'forgot' ? (
          <Tabs value={view === 'signup' ? 'signup' : 'login'} onValueChange={(value) => setMode(value as AuthMode)}>
            <TabsList className="auth-tabs" aria-label="계정 인증 방식">
              <TabsTrigger value="login" disabled={loading}>로그인</TabsTrigger>
              <TabsTrigger value="signup" disabled={loading}>회원가입</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}

        <header className="auth-heading">
          <h1 id="auth-title">{heading}</h1>
          <p>{description}</p>
          {view === 'login' ? <p className="auth-return-context">{getReturnContext(returnTo)}</p> : null}
        </header>

        {notice ? (
          <div className="auth-notice" role="status">
            {notice.kind === 'reset-sent' ? (
              <><strong>재설정 링크를 보냈습니다.</strong><p>{notice.email}의 받은편지함과 스팸함을 확인하세요.</p></>
            ) : (
              <><strong>비밀번호를 변경했습니다.</strong><p>새 비밀번호로 로그인하세요.</p></>
            )}
          </div>
        ) : null}

        {showForm ? (
          <form className="auth-form" onSubmit={onSubmit}>
            <div className="auth-field">
              <Label htmlFor="auth-email">이메일</Label>
              <Input id="auth-email" type="email" autoComplete="email" value={email}
                onChange={(event) => setEmail(event.target.value)} disabled={loading} required />
            </div>
            {view !== 'forgot' ? (
              <div className="auth-field">
                <Label htmlFor="auth-password">비밀번호</Label>
                <Input id="auth-password" type="password"
                  autoComplete={view === 'signup' ? 'new-password' : 'current-password'} value={password}
                  onChange={(event) => setPassword(event.target.value)} disabled={loading} required />
              </div>
            ) : null}
            {view === 'signup' ? (
              <div className="auth-field">
                <Label htmlFor="signup-password-confirm">비밀번호 확인</Label>
                <Input ref={confirmInputRef} id="signup-password-confirm" type="password" autoComplete="new-password"
                  value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); if (confirmError) setConfirmError(null); }}
                  aria-invalid={confirmError ? true : undefined}
                  aria-describedby={confirmError ? 'signup-password-confirm-error' : undefined}
                  disabled={loading} required />
                {confirmError ? <p id="signup-password-confirm-error" className="auth-field-error">{confirmError}</p> : null}
              </div>
            ) : null}
            <Button type="submit" size="lg" className="w-full" disabled={loading}>
              {loading ? loadingLabel : submitLabel}
            </Button>
          </form>
        ) : null}

        {submitError ? <div ref={errorRef} tabIndex={-1} role="alert" className="auth-error">{submitError}</div> : null}

        <div className="auth-secondary-actions">
          {notice?.kind === 'reset-sent' ? (
            <button type="button" onClick={() => { setNotice(null); setView('forgot'); }} disabled={loading}>다른 이메일로 보내기</button>
          ) : null}
          {view === 'login' ? (
            <button type="button" onClick={() => { setView('forgot'); setNotice(null); setSubmitError(null); }} disabled={loading}>비밀번호를 잊으셨나요?</button>
          ) : null}
          {view === 'forgot' || notice?.kind === 'reset-sent' ? (
            <button type="button" onClick={() => { setView('login'); setNotice(null); setSubmitError(null); }} disabled={loading}>로그인으로 돌아가기</button>
          ) : null}
        </div>

        {view === 'signup' ? (
          <p className="auth-privacy">계정을 만들기 전에 <Link to="/privacy">개인정보처리방침</Link>을 확인하세요.</p>
        ) : null}
      </section>
    </div>
  );
}
