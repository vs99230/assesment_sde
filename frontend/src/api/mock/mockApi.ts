import { MOCK_LATENCY_MS } from '../../config';
import { checkTransition, canEditItem, hasRole, isLead } from '../../lib/rules';
import { PRIORITIES, STATUSES } from '../../lib/labels';
import {
  validateComment,
  validateCreateInput,
  validateUpdateInput,
  type FieldErrors,
} from '../../lib/validation';
import type {
  ActivityEvent,
  ActivityType,
  Dashboard,
  DashboardSection,
  ItemFilters,
  Role,
  User,
  UserRef,
  WorkItem,
} from '../../types';
import type { Api } from '../contract';
import { ApiError } from '../errors';
import { getToken, notifyUnauthorized } from '../session';
import { getDb, persist } from './db';
import type { StoredEvent, StoredItem, StoredUser } from './seed';

/**
 * In-browser fake of the real backend. It deliberately behaves like a real server:
 * it checks the token, enforces permissions, validates input, rejects stale versions
 * and duplicate claims, and honours idempotency keys. The UI cannot tell the difference.
 */

let latencyMs = MOCK_LATENCY_MS;
export function setMockLatency(ms: number): void {
  latencyMs = Math.max(0, ms);
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const nowIso = (): string => new Date().toISOString();

// ---------- request plumbing ----------

function currentUser(): StoredUser {
  const token = getToken();
  const match = token ? /^mock\.(\d+)\./.exec(token) : null;
  const user = match ? getDb().users.find((u) => u.id === Number(match[1])) : undefined;
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
  return user;
}

async function authed<T>(fn: (user: StoredUser) => T, write = false): Promise<T> {
  // The caller is identified synchronously (like a server reading the Authorization header),
  // so two "users" firing requests at the same moment are handled independently.
  let user: StoredUser;
  try {
    user = currentUser();
  } catch (e) {
    await sleep(latencyMs);
    notifyUnauthorized();
    throw e;
  }
  await sleep(latencyMs);
  const result = fn(user);
  if (write) persist();
  return clone(result);
}

// ---------- helpers ----------

const roleOf = (user: StoredUser, teamId: number): Role | null =>
  user.memberships.find((m) => m.teamId === teamId)?.role ?? null;

function userRef(id: number): UserRef {
  return { id, name: getDb().users.find((u) => u.id === id)?.name ?? 'Unknown user' };
}

function toUser(u: StoredUser): User {
  const db = getDb();
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    memberships: u.memberships.map((m) => ({
      teamId: m.teamId,
      teamName: db.teams.find((t) => t.id === m.teamId)?.name ?? 'Unknown',
      role: m.role,
    })),
  };
}

function toItem(s: StoredItem): WorkItem {
  const db = getDb();
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    type: s.type,
    priority: s.priority,
    status: s.status,
    team: db.teams.find((t) => t.id === s.teamId) ?? { id: s.teamId, name: 'Unknown' },
    assignee: s.assigneeId === null ? null : userRef(s.assigneeId),
    createdBy: userRef(s.createdById),
    dueDate: s.dueDate,
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function toEvent(e: StoredEvent): ActivityEvent {
  return {
    id: e.id,
    itemId: e.itemId,
    type: e.type,
    actor: userRef(e.actorId),
    from: e.from,
    to: e.to,
    body: e.body,
    createdAt: e.createdAt,
  };
}

function addEvent(
  itemId: number,
  type: ActivityType,
  actorId: number,
  from: string | null = null,
  to: string | null = null,
  body: string | null = null,
): StoredEvent {
  const db = getDb();
  const event: StoredEvent = { id: db.nextEventId++, itemId, type, actorId, from, to, body, createdAt: nowIso() };
  db.events.push(event);
  return event;
}

function touch(item: StoredItem): void {
  item.version += 1;
  item.updatedAt = nowIso();
}

const forbidden = (message: string) => new ApiError(403, 'FORBIDDEN', message);
const invalid = (message: string) => new ApiError(422, 'INVALID_TRANSITION', message);
const conflict = (item: StoredItem) =>
  new ApiError(409, 'VERSION_CONFLICT', 'The item was modified by someone else.', { latest: toItem(item) });

function validation(fields: FieldErrors, message = 'Please fix the highlighted fields.'): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, { fields });
}

/** Item must exist AND belong to one of the caller's teams, otherwise it "does not exist" (404). */
function findAccessible(user: StoredUser, id: number): { stored: StoredItem; role: Role } {
  const stored = getDb().items.find((i) => i.id === id);
  const role = stored ? roleOf(user, stored.teamId) : null;
  if (!stored || !role) throw new ApiError(404, 'NOT_FOUND', 'Item not found.');
  return { stored, role };
}

function assertAssignable(teamId: number, userId: number): void {
  const target = getDb().users.find((u) => u.id === userId);
  const role = target ? roleOf(target, teamId) : null;
  if (!role || role === 'viewer') {
    throw validation({ assigneeId: 'Choose a team member who can work on items.' });
  }
}

function matches(s: StoredItem, f: ItemFilters, user: StoredUser): boolean {
  if (f.status && s.status !== f.status) return false;
  if (f.priority && s.priority !== f.priority) return false;
  if (f.type && s.type !== f.type) return false;
  if (f.teamId && s.teamId !== f.teamId) return false;
  if (f.assignee) {
    if (f.assignee === 'me' && s.assigneeId !== user.id) return false;
    if (f.assignee === 'unassigned' && s.assigneeId !== null) return false;
    if (/^\d+$/.test(f.assignee) && s.assigneeId !== Number(f.assignee)) return false;
  }
  if (f.q) {
    const q = f.q.trim().toLowerCase();
    const haystack = `ops-${s.id} ${s.title} ${s.description}`.toLowerCase();
    if (q && !haystack.includes(q)) return false;
  }
  switch (f.view) {
    case 'assigned_to_me':
      return s.assigneeId === user.id && s.status !== 'resolved' && s.status !== 'closed';
    case 'unassigned_urgent':
      return s.assigneeId === null && s.priority === 'urgent' && s.status === 'open';
    case 'awaiting_my_approval':
      return s.status === 'awaiting_approval' && isLead(roleOf(user, s.teamId));
    default:
      return true;
  }
}

function visibleSorted(user: StoredUser, filters: ItemFilters): StoredItem[] {
  return getDb()
    .items.filter((s) => roleOf(user, s.teamId) !== null && matches(s, filters, user))
    .sort((a, b) => b.id - a.id);
}

function parseCursor(cursor: string | null): number {
  if (cursor === null || cursor === '') return Number.POSITIVE_INFINITY;
  const n = Number(cursor);
  if (!Number.isInteger(n) || n < 0) throw validation({ cursor: 'Invalid cursor.' }, 'Invalid cursor.');
  return n;
}

function clampLimit(limit: number): number {
  return Math.min(100, Math.max(1, Math.floor(limit) || 20));
}

// ---------- the API ----------

export const mockApi: Api = {
  async login(email, password) {
    await sleep(latencyMs);
    const wanted = email.trim().toLowerCase();
    const user = getDb().users.find((u) => u.email.toLowerCase() === wanted && u.password === password);
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Invalid email or password.');
    return clone({
      token: `mock.${user.id}.${Math.random().toString(36).slice(2, 10)}`,
      user: toUser(user),
    });
  },

  me: () => authed((user) => toUser(user)),

  teamMembers: (teamId) =>
    authed((user) => {
      if (!roleOf(user, teamId)) throw new ApiError(404, 'NOT_FOUND', 'Team not found.');
      return getDb()
        .users.flatMap((u) => {
          const role = roleOf(u, teamId);
          return role ? [{ id: u.id, name: u.name, role }] : [];
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    }),

  dashboard: () =>
    authed((user): Dashboard => {
      const section = (view: NonNullable<ItemFilters['view']>): DashboardSection => {
        const all = visibleSorted(user, { view });
        return { total: all.length, items: all.slice(0, 5).map(toItem) };
      };
      return {
        assignedToMe: section('assigned_to_me'),
        unassignedUrgent: section('unassigned_urgent'),
        awaitingMyApproval: section('awaiting_my_approval'),
      };
    }),

  listItems: (filters, cursor, limit) =>
    authed((user) => {
      const before = parseCursor(cursor);
      const size = clampLimit(limit);
      const page = visibleSorted(user, filters).filter((s) => s.id < before).slice(0, size + 1);
      const items = page.slice(0, size);
      const last = items[items.length - 1];
      return {
        items: items.map(toItem),
        nextCursor: page.length > size && last ? String(last.id) : null,
      };
    }),

  getItem: (id) => authed((user) => toItem(findAccessible(user, id).stored)),

  createItem: (input, idempotencyKey) =>
    authed((user) => {
      const db = getDb();
      const hash = JSON.stringify([
        input.title.trim(),
        input.description.trim(),
        input.type,
        input.priority,
        input.teamId,
        input.dueDate ?? null,
        input.assigneeId ?? null,
      ]);
      const idemKey = `${user.id}:${idempotencyKey}`;

      if (idempotencyKey) {
        const prior = db.idempotency[idemKey];
        if (prior) {
          if (prior.hash !== hash) {
            throw new ApiError(
              422,
              'IDEMPOTENCY_KEY_REUSED',
              'This request key was already used with different data.',
            );
          }
          return prior.response; // replay: same answer, nothing created
        }
      }

      const fields = validateCreateInput(input);
      if (Object.keys(fields).length > 0) throw validation(fields);

      const role = roleOf(user, input.teamId);
      if (!hasRole(role, 'member')) throw forbidden('You need the Member role in this team to create items.');
      if (input.assigneeId !== null && input.assigneeId !== undefined) {
        if (!isLead(role)) throw forbidden('Only Leads can assign an item when creating it.');
        assertAssignable(input.teamId, input.assigneeId);
      }

      const now = nowIso();
      const stored: StoredItem = {
        id: db.nextItemId++,
        title: input.title.trim(),
        description: input.description.trim(),
        type: input.type,
        priority: input.priority,
        status: 'open',
        teamId: input.teamId,
        assigneeId: input.assigneeId ?? null,
        createdById: user.id,
        dueDate: input.dueDate || null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.items.push(stored);
      addEvent(stored.id, 'created', user.id);
      if (stored.assigneeId !== null) {
        addEvent(stored.id, 'assignee_changed', user.id, null, userRef(stored.assigneeId).name);
      }

      const response = toItem(stored);
      if (idempotencyKey) db.idempotency[idemKey] = { hash, response: clone(response) };
      return response;
    }, true),

  updateItem: (id, input) =>
    authed((user) => {
      const { stored, role } = findAccessible(user, id);
      if (!hasRole(role, 'member')) throw forbidden('You need the Member role in this team to edit items.');
      if (stored.status === 'closed') throw validation({}, 'Closed items cannot be edited.');
      if (!canEditItem(toItem(stored), role, user.id)) {
        throw forbidden('You can only edit items that are assigned to you.');
      }
      if (typeof input.version !== 'number') throw validation({ version: 'Version is required.' });
      if (input.version !== stored.version) throw conflict(stored);

      const fields = validateUpdateInput(input);
      if (Object.keys(fields).length > 0) throw validation(fields);

      const reassign = input.assigneeId !== undefined && input.assigneeId !== stored.assigneeId;
      if (reassign) {
        if (!isLead(role)) throw forbidden('Only Leads can reassign items.');
        assertAssignable(stored.teamId, input.assigneeId as number);
      }

      const edited: string[] = [];
      const priorityEvent: { from: string; to: string }[] = [];
      let assigneeEvent: { from: string | null; to: string } | null = null;

      const title = input.title?.trim();
      if (title !== undefined && title !== stored.title) {
        stored.title = title;
        edited.push('title');
      }
      const description = input.description?.trim();
      if (description !== undefined && description !== stored.description) {
        stored.description = description;
        edited.push('description');
      }
      if (input.dueDate !== undefined && (input.dueDate || null) !== stored.dueDate) {
        stored.dueDate = input.dueDate || null;
        edited.push('due date');
      }
      if (input.priority !== undefined && input.priority !== stored.priority) {
        priorityEvent.push({ from: stored.priority, to: input.priority });
        stored.priority = input.priority;
      }
      if (reassign) {
        assigneeEvent = {
          from: stored.assigneeId === null ? null : userRef(stored.assigneeId).name,
          to: userRef(input.assigneeId as number).name,
        };
        stored.assigneeId = input.assigneeId as number;
      }

      if (edited.length === 0 && priorityEvent.length === 0 && !assigneeEvent) return toItem(stored);

      touch(stored); // ONE version bump per successful write
      if (edited.length > 0) addEvent(stored.id, 'field_updated', user.id, null, edited.join(', '));
      for (const p of priorityEvent) addEvent(stored.id, 'priority_changed', user.id, p.from, p.to);
      if (assigneeEvent) addEvent(stored.id, 'assignee_changed', user.id, assigneeEvent.from, assigneeEvent.to);
      return toItem(stored);
    }, true),

  claimItem: (id) =>
    authed((user) => {
      const { stored, role } = findAccessible(user, id);
      if (!hasRole(role, 'member')) throw forbidden('You need the Member role in this team to claim items.');
      // The "conditional update": succeeds only if nobody holds the item yet.
      if (stored.assigneeId !== null) {
        throw new ApiError(409, 'ALREADY_CLAIMED', 'This item has already been claimed.', {
          latest: toItem(stored),
        });
      }
      if (stored.status !== 'open') throw invalid('Only open items can be claimed.');
      stored.assigneeId = user.id;
      touch(stored);
      addEvent(stored.id, 'assignee_changed', user.id, null, user.name);
      return toItem(stored);
    }, true),

  transitionItem: (id, to, version) =>
    authed((user) => {
      if (!STATUSES.includes(to)) throw validation({ to: 'Unknown status.' });
      const { stored, role } = findAccessible(user, id);
      if (!hasRole(role, 'member')) throw forbidden('You need the Member role in this team to do that.');
      if (version !== stored.version) throw conflict(stored);

      const check = checkTransition({
        from: stored.status,
        to,
        role,
        userId: user.id,
        assigneeId: stored.assigneeId,
      });
      if (!check.ok) throw check.reason === 'forbidden' ? forbidden(check.message) : invalid(check.message);

      const from = stored.status;
      stored.status = to;
      touch(stored);
      addEvent(stored.id, 'status_changed', user.id, from, to);
      return toItem(stored);
    }, true),

  listActivity: (id, cursor, limit) =>
    authed((user) => {
      findAccessible(user, id);
      const before = parseCursor(cursor);
      const size = clampLimit(limit);
      const page = getDb()
        .events.filter((e) => e.itemId === id && e.id < before)
        .sort((a, b) => b.id - a.id)
        .slice(0, size + 1);
      const events = page.slice(0, size);
      const last = events[events.length - 1];
      return {
        items: events.map(toEvent),
        nextCursor: page.length > size && last ? String(last.id) : null,
      };
    }),

  addComment: (id, body) =>
    authed((user) => {
      const { stored, role } = findAccessible(user, id);
      if (!hasRole(role, 'member')) throw forbidden('You need the Member role in this team to comment.');
      const problem = validateComment(body);
      if (problem) throw validation({ body: problem }, problem);
      return toEvent(addEvent(stored.id, 'comment', user.id, null, null, body.trim()));
    }, true),
};

// ---------- demo helpers (mock mode only) ----------

export const mockTools = {
  /**
   * Pretends another user just edited the item: bumps its version behind the UI's back.
   * The next action from the (now stale) screen is rejected with a version conflict.
   */
  simulateExternalChange(itemId: number): boolean {
    const db = getDb();
    const stored = db.items.find((i) => i.id === itemId);
    if (!stored) return false;
    const actor =
      db.users.find((u) => u.memberships.some((m) => m.teamId === stored.teamId && isLead(m.role))) ?? db.users[0]!;
    const from = stored.priority;
    const to = PRIORITIES[(PRIORITIES.indexOf(from) + 1) % PRIORITIES.length]!;
    stored.priority = to;
    touch(stored);
    addEvent(stored.id, 'priority_changed', actor.id, from, to);
    persist();
    return true;
  },
};
