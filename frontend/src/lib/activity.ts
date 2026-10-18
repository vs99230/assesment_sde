import type { ActivityEvent, Priority, Status } from '../types';
import { PRIORITY_LABEL, STATUS_LABEL } from './labels';

const status = (v: string | null): string => (v ? (STATUS_LABEL[v as Status] ?? v) : '—');
const priority = (v: string | null): string => (v ? (PRIORITY_LABEL[v as Priority] ?? v) : '—');

/** Human-readable sentence for an activity event (comments are shown separately). */
export function describeEvent(ev: ActivityEvent): string {
  switch (ev.type) {
    case 'created':
      return 'created this item';
    case 'status_changed':
      return `changed status from ${status(ev.from)} to ${status(ev.to)}`;
    case 'assignee_changed':
      if (!ev.from && ev.to === ev.actor.name) return 'claimed this item';
      if (!ev.from) return `assigned this item to ${ev.to ?? 'someone'}`;
      return `reassigned this item from ${ev.from} to ${ev.to ?? 'someone'}`;
    case 'priority_changed':
      return `changed priority from ${priority(ev.from)} to ${priority(ev.to)}`;
    case 'field_updated':
      return `updated ${ev.to ?? 'details'}`;
    case 'comment':
      return 'commented';
    default:
      return 'made a change';
  }
}
