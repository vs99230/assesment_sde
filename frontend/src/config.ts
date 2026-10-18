function read(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** true => in-browser mock API, false => real backend. Controlled by VITE_USE_MOCK in .env */
export const USE_MOCK: boolean =
  read(import.meta.env.VITE_USE_MOCK, 'true').toLowerCase() === 'true';

/** Base URL of the real backend (no trailing slash). Only used when USE_MOCK is false. */
export const API_BASE_URL: string = read(
  import.meta.env.VITE_API_BASE_URL,
  'http://localhost:8000',
).replace(/\/+$/, '');

const latency = Number(read(import.meta.env.VITE_MOCK_LATENCY_MS, '300'));
/** Artificial delay for mock responses, in milliseconds. */
export const MOCK_LATENCY_MS: number = Number.isFinite(latency) ? Math.max(0, latency) : 300;

/** Items per page for list screens. */
export const PAGE_SIZE = 20;
