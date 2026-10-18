const KEY = 'ops.token';

let memoryToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

function storage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* storage blocked */
  }
  return null;
}

export function getToken(): string | null {
  try {
    const s = storage();
    if (s) return s.getItem(KEY);
  } catch {
    /* fall through to memory */
  }
  return memoryToken;
}

export function setToken(token: string): void {
  memoryToken = token;
  try {
    storage()?.setItem(KEY, token);
  } catch {
    /* keep in memory only */
  }
}

export function clearToken(): void {
  memoryToken = null;
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Registered by AuthProvider: called when the server says the session is no longer valid. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export function notifyUnauthorized(): void {
  unauthorizedHandler?.();
}
