import { isApiError } from '../api/errors';

export interface Notice {
  tone: 'error' | 'warning';
  message: string;
}

/** Turns any thrown error into a message the user can act on. */
export function describeActionError(err: unknown): Notice {
  if (isApiError(err)) {
    switch (err.code) {
      case 'VERSION_CONFLICT':
        return {
          tone: 'warning',
          message:
            'This item was changed by someone else while you were working. Your change was NOT applied. The latest version is now shown — review it and try again.',
        };
      case 'ALREADY_CLAIMED':
        return {
          tone: 'warning',
          message: 'Someone else claimed this item first. The latest version is now shown.',
        };
      case 'NETWORK_ERROR':
        return { tone: 'error', message: err.message };
      case 'FORBIDDEN':
        return { tone: 'error', message: err.message || 'You are not allowed to do that.' };
      case 'NOT_FOUND':
        return { tone: 'error', message: 'This item no longer exists or you no longer have access.' };
      default:
        return { tone: 'error', message: err.message };
    }
  }
  return {
    tone: 'error',
    message: err instanceof Error ? err.message : 'Something went wrong. Please try again.',
  };
}
