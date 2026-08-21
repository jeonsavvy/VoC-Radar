import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  getAuthErrorMessage,
  updatePassword,
  validateSignupPasswords,
  type AuthAction,
} from '@/lib/auth';
import { sanitizeAuthReturnTo } from '@/lib/authRedirect';

type Props = {
  authChecking: boolean;
  loggedIn: boolean;
  onSignedOut: () => Promise<void>;
};
const PASSWORD_UPDATE_ACTION = 'password-update' satisfies AuthAction;

export function ResetPasswordPage({ authChecking, loggedIn, onSignedOut }: Props) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = useMemo(() => sanitizeAuthReturnTo(searchParams.get('returnTo')), [searchParams]);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const confirmInputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (submitError) errorRef.current?.focus();
  }, [submitError]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (authChecking || loading) return;
    setSubmitError(null);
    setConfirmError(null);
    const passwordError = validateSignupPasswords(password, confirmPassword);
    if (passwordError) {
      setConfirmError(passwordError);
      requestAnimationFrame(() => confirmInputRef.current?.focus());
      return;
    }

    setLoading(true);
    try {
      await updatePassword(password);
      await onSignedOut();
      const next = new URLSearchParams({ passwordUpdated: '1' });
      if (returnTo !== '/requests') next.set('returnTo', returnTo);
      navigate(`/login?${next.toString()}`, { replace: true });
    } catch (error) {
      setSubmitError(getAuthErrorMessage(error, PASSWORD_UPDATE_ACTION));
    } finally {
      setLoading(false);
    }
  };

  const invalidLink = !authChecking && !loggedIn;
  const disabled = authChecking || invalidLink || loading;
  return (
    <div className="auth-page">
      <section className="auth-panel" aria-labelledby="reset-password-title">
        <header className="auth-heading">
          <h1 id="reset-password-title">새 비밀번호 설정</h1>
          <p>앞으로 로그인할 때 사용할 비밀번호를 입력하세요.</p>
        </header>
        {authChecking ? <div className="auth-notice" role="status">재설정 링크를 확인하고 있습니다.</div> : null}
        {invalidLink ? (
          <div className="auth-error" role="alert">
            재설정 링크가 만료되었거나 유효하지 않습니다. 로그인 화면에서 새 링크를 요청하세요.
          </div>
        ) : null}
        {!invalidLink ? <form className="auth-form" onSubmit={onSubmit}>
          <div className="auth-field">
            <Label htmlFor="reset-password">새 비밀번호</Label>
            <Input id="reset-password" type="password" autoComplete="new-password" value={password}
              onChange={(event) => setPassword(event.target.value)} disabled={disabled} required />
          </div>
          <div className="auth-field">
            <Label htmlFor="reset-password-confirm">새 비밀번호 확인</Label>
            <Input ref={confirmInputRef} id="reset-password-confirm" type="password" autoComplete="new-password"
              value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); if (confirmError) setConfirmError(null); }}
              aria-invalid={confirmError ? true : undefined}
              aria-describedby={confirmError ? 'reset-password-confirm-error' : undefined}
              disabled={disabled} required />
            {confirmError ? <p id="reset-password-confirm-error" className="auth-field-error">{confirmError}</p> : null}
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={disabled}>
            {authChecking ? '링크 확인 중' : loading ? '변경하는 중' : '비밀번호 변경'}
          </Button>
        </form> : null}
        {submitError ? <div ref={errorRef} tabIndex={-1} role="alert" className="auth-error">{submitError}</div> : null}
        <div className="auth-secondary-actions"><Link to="/login">로그인으로 돌아가기</Link></div>
      </section>
    </div>
  );
}
