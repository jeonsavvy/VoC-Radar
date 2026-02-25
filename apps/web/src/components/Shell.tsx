import { NavLink, Outlet } from 'react-router-dom';

type Props = {
  loggedIn: boolean;
  onSignOut: () => void;
};

const navItems = [
  { to: '/', label: 'Overview' },
  { to: '/apps/1018769995', label: 'App Summary' },
  { to: '/trends', label: 'Trends' },
  { to: '/categories', label: 'Categories' },
  { to: '/reviews', label: 'Reviews' },
];

export function Shell({ loggedIn, onSignOut }: Props) {
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
            <NavLink to="/login" className="ghost-button">
              로그인
            </NavLink>
          )}
        </div>
      </header>

      <main className="content" role="main">
        <Outlet />
      </main>
    </div>
  );
}
