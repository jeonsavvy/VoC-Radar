import { FormEvent, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { isValidAppId, normalizeCountry, type AppSelection } from '../lib/appSelection';
import { getPublicApps } from '../lib/api';

type Props = {
  loggedIn: boolean;
  onSignOut: () => void;
  selection: AppSelection;
  onSelectionChange: (next: AppSelection) => void;
};

export function Shell({ loggedIn, onSignOut, selection, onSelectionChange }: Props) {
  const [appIdInput, setAppIdInput] = useState(selection.appId);
  const [countryInput, setCountryInput] = useState(selection.country);
  const [appName, setAppName] = useState<string | null>(null);

  useEffect(() => {
    setAppIdInput(selection.appId);
    setCountryInput(selection.country);
  }, [selection.appId, selection.country]);

  useEffect(() => {
    let mounted = true;

    getPublicApps(100)
      .then((response) => {
        if (!mounted) {
          return;
        }
        const found = response.data.find(
          (item) => item.app_store_id === selection.appId && item.country.toLowerCase() === selection.country.toLowerCase(),
        );
        setAppName(found?.app_name?.trim() || null);
      })
      .catch(() => {
        if (mounted) {
          setAppName(null);
        }
      });

    return () => {
      mounted = false;
    };
  }, [selection.appId, selection.country]);

  const navItems = [
    { to: '/', label: 'Overview' },
    { to: `/apps/${selection.appId}`, label: 'App Summary' },
    { to: '/trends', label: 'Trends' },
    { to: '/categories', label: 'Categories' },
    { to: '/analyze', label: 'Analyze' },
    { to: '/reviews', label: 'Reviews' },
  ];

  const onApplySelection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextAppId = appIdInput.trim();
    if (!isValidAppId(nextAppId)) {
      return;
    }

    onSelectionChange({
      appId: nextAppId,
      country: normalizeCountry(countryInput),
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar" role="banner">
        <div className="brand">
          <span className="brand-badge" aria-hidden="true">
            VR
          </span>
          <div>
            <h1>VoC Radar</h1>
            <p>App Store Voice of Customer Report</p>
          </div>
        </div>

        <nav aria-label="Primary navigation">
          <ul className="nav-list">
            {navItems.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div>
          {loggedIn ? (
            <button className="ghost-button" onClick={onSignOut} type="button">
              로그아웃
            </button>
          ) : (
            <div className="auth-links">
              <NavLink to="/login" className="ghost-button">
                로그인
              </NavLink>
              <NavLink to="/login?mode=signup" className="ghost-button">
                회원가입
              </NavLink>
            </div>
          )}
        </div>

        <form className="topbar-form" onSubmit={onApplySelection}>
          <label htmlFor="topbar-app-id">App ID</label>
          <input
            id="topbar-app-id"
            value={appIdInput}
            onChange={(event) => setAppIdInput(event.target.value)}
            placeholder="1018769995"
          />
          <label htmlFor="topbar-country">Country</label>
          <input
            id="topbar-country"
            value={countryInput}
            onChange={(event) => setCountryInput(event.target.value)}
            maxLength={2}
            placeholder="kr"
          />
          <button type="submit" className="ghost-button">
            적용
          </button>
        </form>

        <p className="topbar-help">
          선택 앱: <strong>{appName || 'Unknown App'}</strong> · ID <code>{selection.appId}</code> ·{' '}
          <code>{selection.country}</code> · 앱스토어 URL의 <code>id숫자</code>가 App ID입니다.
        </p>
      </header>

      <main className="content" role="main">
        <Outlet />
      </main>
    </div>
  );
}
