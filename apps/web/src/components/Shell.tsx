import { useState } from 'react';
import { ChevronDown, LogIn, Search, X } from 'lucide-react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { GlobalSearch } from '@/components/GlobalSearch';

type Props = {
  loggedIn: boolean;
  userEmail?: string | null;
  onSignOut: () => void | Promise<void>;
};

export function Shell({ loggedIn, userEmail, onSignOut }: Props) {
  const location = useLocation();
  const [mobileSearch, setMobileSearch] = useState(false);
  const country = location.pathname.match(/^\/apps\/([a-z]{2})\//)?.[1] || 'kr';

  return (
    <div className="app-shell">
      <header className="product-header">
        <div className="product-header__inner">
          <Link to="/" className="wordmark" aria-label="VoC Radar 홈">
            VoC Radar
          </Link>
          <div className="product-header__search">
            <GlobalSearch country={country} />
          </div>
          <nav aria-label="사용자 메뉴" className="product-header__actions">
            <button
              type="button"
              className="icon-button mobile-search-button"
              aria-label={mobileSearch ? '검색 닫기' : '앱 검색 열기'}
              onClick={() => setMobileSearch((value) => !value)}
            >
              {mobileSearch ? <X /> : <Search />}
            </button>
            {loggedIn ? (
              <details className="account-menu">
                <summary>
                  <span className="account-avatar">{userEmail?.[0]?.toUpperCase() || 'U'}</span>
                  <span className="account-label">계정</span>
                  <ChevronDown aria-hidden="true" />
                </summary>
                <div className="account-menu__panel">
                  <p title={userEmail || undefined}>{userEmail || '로그인됨'}</p>
                  <NavLink to="/requests">분석 요청 내역</NavLink>
                  <button type="button" onClick={onSignOut}>로그아웃</button>
                </div>
              </details>
            ) : (
              <Link className="login-link" to={`/login?returnTo=${encodeURIComponent(location.pathname)}`}>
                <LogIn aria-hidden="true" />
                로그인
              </Link>
            )}
          </nav>
        </div>
        {mobileSearch ? (
          <div className="mobile-search-panel">
            <GlobalSearch country={country} autoFocus onNavigate={() => setMobileSearch(false)} />
          </div>
        ) : null}
      </header>

      <main className="page-frame"><Outlet /></main>
      <footer className="product-footer">
        <span>© VoC Radar</span>
        <Link to="/privacy">개인정보처리방침</Link>
      </footer>
    </div>
  );
}
