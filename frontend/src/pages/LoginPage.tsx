import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { DEMO_PASSWORD, DEMO_USERS } from '../api/mock/seed';
import { useAuth } from '../auth/AuthContext';
import { Banner } from '../components/Feedback';
import { USE_MOCK } from '../config';
import { errorMessage } from '../api/errors';
import { ROLE_LABEL } from '../lib/labels';
import { validateLogin, type FieldErrors } from '../lib/validation';

export default function LoginPage() {
  const { login, status } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authed') return <Navigate to={from} replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const found = validateLogin(email, password);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setFormError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="login-grid">
        <form className="card narrow" onSubmit={onSubmit} noValidate>
          <h1>Sign in</h1>
          <p className="muted">Ops Under Pressure — operational work tracker.</p>

          {formError && <Banner tone="error">{formError}</Banner>}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'email-err' : undefined}
            />
            {errors.email && (
              <p id="email-err" className="field-error">
                {errors.email}
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? 'password-err' : undefined}
            />
            {errors.password && (
              <p id="password-err" className="field-error">
                {errors.password}
              </p>
            )}
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {USE_MOCK && (
          <aside className="card demo-card" aria-label="Demo accounts">
            <h2>Demo accounts</h2>
            <p className="muted small">
              Mock mode. Password for all: <code>{DEMO_PASSWORD}</code>. Click one to fill the form.
            </p>
            <ul className="demo-list">
              {DEMO_USERS.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    className="demo-user"
                    onClick={() => {
                      setEmail(u.email);
                      setPassword(DEMO_PASSWORD);
                      setErrors({});
                      setFormError(null);
                    }}
                  >
                    <strong>{u.name}</strong>
                    <span className="muted small">{u.email}</span>
                    <span className="muted small">
                      {u.memberships
                        .map((m) => `${['', 'Payments', 'Support', 'Compliance', 'Platform'][m.teamId]}: ${ROLE_LABEL[m.role]}`)
                        .join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  );
}
