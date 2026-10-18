import { Link, NavLink, Outlet } from 'react-router-dom';
import { resetMockDb } from '../api/mock/db';
import { useAuth } from '../auth/AuthContext';
import { USE_MOCK } from '../config';
import { ROLE_LABEL } from '../lib/labels';
import { canCreateInTeam } from '../lib/rules';

export default function Layout() {
  const { user, logout } = useAuth();
  if (!user) return null;

  const canCreate = user.memberships.some((m) => canCreateInTeam(m.role));
  const roles = user.memberships.map((m) => `${m.teamName}: ${ROLE_LABEL[m.role]}`).join(' · ');
  const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'nav-link active' : 'nav-link');

  const resetDemo = () => {
    if (window.confirm('Reset all demo data back to the starting state?')) {
      resetMockDb();
      window.location.assign('/');
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="container topbar-inner">
          <Link to="/" className="brand">
            Ops<span> Under Pressure</span>
          </Link>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end className={navClass}>
              Dashboard
            </NavLink>
            <NavLink to="/items" end className={navClass}>
              All items
            </NavLink>
            {canCreate && (
              <NavLink to="/items/new" className={navClass}>
                New item
              </NavLink>
            )}
          </nav>
          <div className="user-box">
            <div className="user-text" title={roles}>
              <strong>{user.name}</strong>
              <small className="muted">{roles}</small>
            </div>
            <button type="button" className="btn btn-small" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="container main">
        <Outlet />
      </main>

      {USE_MOCK && (
        <footer className="footer">
          <div className="container">
            <span className="badge mock-badge">MOCK DATA</span>{' '}
            <span className="muted">
              Running on built-in demo data. Set <code>VITE_USE_MOCK=false</code> in <code>.env</code> to use the
              real API.
            </span>{' '}
            <button type="button" className="link-button" onClick={resetDemo}>
              Reset demo data
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
