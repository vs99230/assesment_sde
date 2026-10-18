import type { Role, Status, User, WorkItem } from '../types';

/**
 * Business rules shared by the UI (to show/hide buttons) and by the mock API
 * (to act as the "server"). The REAL backend must enforce the same rules;
 * hiding a button is never a security measure.
 */

export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, lead: 2, admin: 3 };

export function hasRole(role: Role | null | undefined, min: Role): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[min];
}

export const isLead = (role: Role | null | undefined): boolean => hasRole(role, 'lead');

export function roleInTeam(user: Pick<User, 'memberships'>, teamId: number): Role | null {
  return user.memberships.find((m) => m.teamId === teamId)?.role ?? null;
}

/**
 * Allowed workflow moves. The value says who may perform the move:
 *  - 'assignee': the assignee, or a Lead/Admin of the team
 *  - 'lead':     only a Lead/Admin of the team
 */
export const TRANSITIONS: Record<Status, Partial<Record<Status, 'assignee' | 'lead'>>> = {
  open: { in_progress: 'assignee' },
  in_progress: { awaiting_approval: 'assignee' },
  awaiting_approval: { resolved: 'lead', in_progress: 'lead' },
  resolved: { closed: 'lead' },
  closed: {},
};

export type TransitionCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'forbidden'; message: string };

export function checkTransition(args: {
  from: Status;
  to: Status;
  role: Role | null;
  userId: number;
  assigneeId: number | null;
}): TransitionCheck {
  const { from, to, role, userId, assigneeId } = args;
  const rule = TRANSITIONS[from][to];
  if (!rule) {
    return { ok: false, reason: 'invalid', message: `An item cannot move from "${from}" to "${to}".` };
  }
  if (!hasRole(role, 'member')) {
    return { ok: false, reason: 'forbidden', message: 'You need the Member role in this team to do that.' };
  }
  if (from === 'open' && to === 'in_progress' && assigneeId === null) {
    return { ok: false, reason: 'invalid', message: 'Claim the item (or ask a Lead to assign it) before starting work.' };
  }
  if (rule === 'lead' && !isLead(role)) {
    return { ok: false, reason: 'forbidden', message: 'Only a Lead of this team can do that.' };
  }
  if (rule === 'assignee' && !isLead(role) && assigneeId !== userId) {
    return { ok: false, reason: 'forbidden', message: 'Only the assignee or a Lead can do that.' };
  }
  return { ok: true };
}

/** Workflow moves the given user may perform right now (used to render buttons). */
export function allowedTransitions(item: WorkItem, role: Role | null, userId: number): Status[] {
  return (Object.keys(TRANSITIONS[item.status]) as Status[]).filter(
    (to) =>
      checkTransition({ from: item.status, to, role, userId, assigneeId: item.assignee?.id ?? null }).ok,
  );
}

export const canCreateInTeam = (role: Role | null | undefined): boolean => hasRole(role, 'member');
export const canComment = (role: Role | null | undefined): boolean => hasRole(role, 'member');
export const canReassign = (role: Role | null | undefined): boolean => isLead(role);

export function canClaim(item: WorkItem, role: Role | null): boolean {
  return hasRole(role, 'member') && item.assignee === null && item.status === 'open';
}

export function canEditItem(item: WorkItem, role: Role | null, userId: number): boolean {
  if (item.status === 'closed') return false;
  if (isLead(role)) return true;
  if (role !== 'member') return false;
  return item.assignee?.id === userId || (item.assignee === null && item.createdBy.id === userId);
}
