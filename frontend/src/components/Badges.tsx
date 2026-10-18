import type { Priority, Status } from '../types';
import { PRIORITY_LABEL, STATUS_LABEL } from '../lib/labels';

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`badge priority-${priority}`}>{PRIORITY_LABEL[priority]}</span>;
}
