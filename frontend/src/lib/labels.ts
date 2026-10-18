import type { ItemType, Priority, Role, Status } from '../types';

export const STATUSES: readonly Status[] = [
  'open',
  'in_progress',
  'awaiting_approval',
  'resolved',
  'closed',
];
export const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'urgent'];
export const ITEM_TYPES: readonly ItemType[] = [
  'incident',
  'customer_issue',
  'payment',
  'compliance',
  'task',
];

export const STATUS_LABEL: Record<Status, string> = {
  open: 'Open',
  in_progress: 'In progress',
  awaiting_approval: 'Awaiting approval',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

export const TYPE_LABEL: Record<ItemType, string> = {
  incident: 'Incident',
  customer_issue: 'Customer issue',
  payment: 'Payment',
  compliance: 'Compliance',
  task: 'Task',
};

export const ROLE_LABEL: Record<Role, string> = {
  viewer: 'Viewer',
  member: 'Member',
  lead: 'Lead',
  admin: 'Admin',
};

export const itemCode = (id: number): string => `OPS-${id}`;

/** Button text for a workflow move. */
export function transitionLabel(from: Status, to: Status): string {
  if (from === 'open' && to === 'in_progress') return 'Start work';
  if (from === 'in_progress' && to === 'awaiting_approval') return 'Submit for approval';
  if (from === 'awaiting_approval' && to === 'resolved') return 'Approve & resolve';
  if (from === 'awaiting_approval' && to === 'in_progress') return 'Send back';
  if (to === 'closed') return 'Close item';
  return `Move to ${STATUS_LABEL[to]}`;
}
