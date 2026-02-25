import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithPassword } from '../lib/auth';

type Props = {
  onSignedIn: () => Promise<void>;
};

export function LoginPage({ onSignedIn }: Props) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await signInWithPassword(email, password);
      await onSignedIn();
      navigate('/reviews');
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인 실패');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel auth-panel" aria-labelledby="login-heading">
      <h2 id="login-heading">상세 리뷰 접근 로그인</h2>
      <p className="muted">로그인한 사용자만 `/reviews` 상세 데이터에 접근할 수 있습니다.</p>

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
          {loading ? '로그인 중...' : '로그인'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
