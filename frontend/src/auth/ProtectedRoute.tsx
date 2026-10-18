import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { FullPageSpinner } from '../components/Feedback';
import { useAuth } from './AuthContext';

export default function ProtectedRoute() {
  const { status, user, bootError, retry } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <FullPageSpinner label="Loading your session…" />;

  if (status === 'error') {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <h1>Can’t reach the server</h1>
          <p className="muted">{bootError}</p>
          <button type="button" className="btn btn-primary" onClick={retry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (status === 'anon' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <Outlet />;
}
