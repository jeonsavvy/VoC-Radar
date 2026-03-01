import { FormEvent, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { signInWithPassword, signUpWithPassword } from '../lib/auth';

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
      if (mode === 'signup') {
        const result = await signUpWithPassword(email, password);
        if (result.hasSession) {
          await onSignedIn();
          navigate('/analyze');
          return;
        }
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
    <section className="panel auth-panel" aria-labelledby="login-heading">
      <h2 id="login-heading">{mode === 'signup' ? '회원가입' : '상세 리뷰 접근 로그인'}</h2>
      <p className="muted">
        {mode === 'signup'
          ? '분석 요청/상세 리뷰 접근을 위해 계정을 만듭니다.'
          : '로그인한 사용자만 `/reviews` 상세 데이터에 접근할 수 있습니다.'}
      </p>

      <div className="auth-mode-switch" role="tablist" aria-label="인증 모드">
        <button
          type="button"
          className={mode === 'login' ? 'ghost-button active-tab' : 'ghost-button'}
          onClick={() => setSearchParams({})}
        >
          로그인
        </button>
        <button
          type="button"
          className={mode === 'signup' ? 'ghost-button active-tab' : 'ghost-button'}
          onClick={() => setSearchParams({ mode: 'signup' })}
        >
          회원가입
        </button>
      </div>

      <form onSubmit={onSubmit}>
        <label htmlFor="email">이메일</label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label htmlFor="password">비밀번호</label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <button className="primary-button" type="submit" disabled={loading}>
          {loading ? (mode === 'signup' ? '가입 처리 중...' : '로그인 중...') : mode === 'signup' ? '회원가입' : '로그인'}
        </button>
      </form>

      {message && <p>{message}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
