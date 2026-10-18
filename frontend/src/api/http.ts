import { API_BASE_URL } from '../config';
import type { Api } from './contract';
import { ApiError, type ErrorCode, type ErrorDetails } from './errors';
import { getToken, notifyUnauthorized } from './session';
import type {
  ActivityEvent,
  Dashboard,
  ItemFilters,
  LoginResult,
  Page,
  TeamMember,
  User,
  WorkItem,
} from '../types';

const TIMEOUT_MS = 15_000;

interface RequestOptions {
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Set false for endpoints that don't need (or must not trigger logout on) a token. */
  auth?: boolean;
}

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'VERSION_CONFLICT',
  422: 'VALIDATION_ERROR',
};

function toApiError(status: number, data: unknown): ApiError {
  const fallbackCode = CODE_BY_STATUS[status] ?? 'UNKNOWN';
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    // Contract format: { error: { code, message, details } }
    if (obj.error && typeof obj.error === 'object') {
      const e = obj.error as Record<string, unknown>;
      return new ApiError(
        status,
        (typeof e.code === 'string' ? e.code : fallbackCode) as ErrorCode,
        typeof e.message === 'string' ? e.message : `Request failed (${status}).`,
        (e.details as ErrorDetails | undefined) ?? undefined,
      );
    }
    // Framework default format: { detail: "..." }
    if (typeof obj.detail === 'string') {
      return new ApiError(status, fallbackCode, obj.detail);
    }
  }
  return new ApiError(status, fallbackCode, `Request failed (${status}).`);
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  const url = `${API_BASE_URL}${path}${qs ? `?${qs}` : ''}`;

  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth !== false) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 204) return undefined as T;

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    if (res.status === 401 && opts.auth !== false) notifyUnauthorized();
    throw toApiError(res.status, data);
  }
  return data as T;
}

export const httpApi: Api = {
  login: (email, password) =>
    request<LoginResult>('POST', '/auth/login', { body: { email, password }, auth: false }),
  me: () => request<User>('GET', '/auth/me'),
  teamMembers: (teamId) => request<TeamMember[]>('GET', `/teams/${teamId}/members`),

  dashboard: () => request<Dashboard>('GET', '/dashboard'),
  listItems: (filters: ItemFilters, cursor, limit) =>
    request<Page<WorkItem>>('GET', '/items', {
      query: {
        status: filters.status,
        priority: filters.priority,
        type: filters.type,
        teamId: filters.teamId,
        assignee: filters.assignee,
        q: filters.q,
        view: filters.view,
        cursor,
        limit,
      },
    }),
  getItem: (id) => request<WorkItem>('GET', `/items/${id}`),
  createItem: (input, idempotencyKey) =>
    request<WorkItem>('POST', '/items', { body: input, headers: { 'Idempotency-Key': idempotencyKey } }),
  updateItem: (id, input) => request<WorkItem>('PATCH', `/items/${id}`, { body: input }),
  claimItem: (id) => request<WorkItem>('POST', `/items/${id}/claim`),
  transitionItem: (id, to, version) =>
    request<WorkItem>('POST', `/items/${id}/transition`, { body: { to, version } }),

  listActivity: (id, cursor, limit) =>
    request<Page<ActivityEvent>>('GET', `/items/${id}/activity`, { query: { cursor, limit } }),
  addComment: (id, body) => request<ActivityEvent>('POST', `/items/${id}/comments`, { body: { body } }),
};
