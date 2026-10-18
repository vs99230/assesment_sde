import { USE_MOCK } from '../config';
import type { Api } from './contract';
import { httpApi } from './http';
import { mockApi } from './mock/mockApi';

/** The one API object the whole UI uses. Chosen by VITE_USE_MOCK in .env */
export const api: Api = USE_MOCK ? mockApi : httpApi;

export { ApiError, isApiError, errorMessage } from './errors';
