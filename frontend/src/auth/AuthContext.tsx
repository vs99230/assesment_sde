import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { isApiError } from '../api/errors';
import { clearToken, getToken, setToken, setUnauthorizedHandler } from '../api/session';
import type { User } from '../types';

type Status = 'loading' | 'authed' | 'anon' | 'error';

interface AuthState {
  user: User | null;
  status: Status;
  bootError: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  retry: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>(getToken() ? 'loading' : 'anon');
  const [bootError, setBootError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // If any request comes back 401, drop the session and go to the login page.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearToken();
      qc.clear();
      setUser(null);
      setStatus('anon');
    });
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  // Restore the session on first load.
  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    setStatus('loading');
    api
      .me()
      .then((u) => {
        if (cancelled) return;
        setUser(u);
        setStatus('authed');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isApiError(err) && err.status === 401) {
          clearToken();
          setStatus('anon');
        } else {
          // Server unreachable: keep the token, let the user retry.
          setBootError(err instanceof Error ? err.message : 'Could not load your session.');
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api.login(email.trim(), password);
      qc.clear();
      setToken(result.token);
      setUser(result.user);
      setBootError(null);
      setStatus('authed');
    },
    [qc],
  );

  const logout = useCallback(() => {
    clearToken();
    qc.clear();
    setUser(null);
    setStatus('anon');
  }, [qc]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const value = useMemo<AuthState>(
    () => ({ user, status, bootError, login, logout, retry }),
    [user, status, bootError, login, logout, retry],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** For pages that only render when signed in. */
export function useCurrentUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error('No signed-in user');
  return user;
}
