import type { ReactNode } from 'react';

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function FullPageSpinner({ label }: { label?: string }) {
  return (
    <div className="center-screen">
      <Spinner label={label} />
    </div>
  );
}

export function Banner({
  tone = 'error',
  children,
  action,
  onDismiss,
}: {
  tone?: 'error' | 'warning' | 'info' | 'success';
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}>
      <div className="banner-body">{children}</div>
      {action}
      {onDismiss && (
        <button type="button" className="banner-close" onClick={onDismiss} aria-label="Dismiss message">
          ×
        </button>
      )}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="card state-card" role="alert">
      <h2>{title}</h2>
      <p className="muted">{message}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, message, action }: { title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="card state-card">
      <h2>{title}</h2>
      {message && <p className="muted">{message}</p>}
      {action}
    </div>
  );
}
