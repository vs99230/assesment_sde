export type Role = 'viewer' | 'member' | 'lead' | 'admin';
export type Status = 'open' | 'in_progress' | 'awaiting_approval' | 'resolved' | 'closed';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type ItemType = 'incident' | 'customer_issue' | 'payment' | 'compliance' | 'task';

export interface Membership {
  teamId: number;
  teamName: string;
  role: Role;
}

export interface User {
  id: number;
  name: string;
  email: string;
  memberships: Membership[];
}

export interface UserRef {
  id: number;
  name: string;
}

export interface TeamRef {
  id: number;
  name: string;
}

export interface TeamMember extends UserRef {
  role: Role;
}

export interface WorkItem {
  id: number;
  title: string;
  description: string;
  type: ItemType;
  priority: Priority;
  status: Status;
  team: TeamRef;
  assignee: UserRef | null;
  createdBy: UserRef;
  /** Calendar date, YYYY-MM-DD */
  dueDate: string | null;
  /** Optimistic-locking counter. Sent back on every write. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ActivityType =
  | 'created'
  | 'status_changed'
  | 'assignee_changed'
  | 'priority_changed'
  | 'field_updated'
  | 'comment';

export interface ActivityEvent {
  id: number;
  itemId: number;
  type: ActivityType;
  actor: UserRef;
  /** Previous value (status / priority code, or assignee name). */
  from: string | null;
  /** New value (status / priority code, assignee name, or list of changed fields). */
  to: string | null;
  /** Comment text (only for type = comment). */
  body: string | null;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when there is no more data. */
  nextCursor: string | null;
}

export type DashboardView = 'assigned_to_me' | 'unassigned_urgent' | 'awaiting_my_approval';

export interface ItemFilters {
  status?: Status;
  priority?: Priority;
  type?: ItemType;
  teamId?: number;
  /** 'me' | 'unassigned' | a user id as string */
  assignee?: string;
  q?: string;
  view?: DashboardView;
}

export interface DashboardSection {
  total: number;
  items: WorkItem[];
}

export interface Dashboard {
  assignedToMe: DashboardSection;
  unassignedUrgent: DashboardSection;
  awaitingMyApproval: DashboardSection;
}

export interface CreateItemInput {
  title: string;
  description: string;
  type: ItemType;
  priority: Priority;
  teamId: number;
  dueDate: string | null;
  assigneeId: number | null;
}

export interface UpdateItemInput {
  /** Version the client last saw. Required. */
  version: number;
  title?: string;
  description?: string;
  priority?: Priority;
  dueDate?: string | null;
  assigneeId?: number;
}

export interface LoginResult {
  token: string;
  user: User;
}
