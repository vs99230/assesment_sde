import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="card state-card">
      <h1>Page not found</h1>
      <p className="muted">That page does not exist.</p>
      <Link to="/" className="btn btn-primary">
        Go to dashboard
      </Link>
    </div>
  );
}
