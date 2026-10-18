import type { ActivityType, ItemType, Priority, Role, Status, TeamRef, WorkItem } from '../../types';

export interface StoredUser {
  id: number;
  name: string;
  email: string;
  password: string;
  memberships: { teamId: number; role: Role }[];
}

export interface StoredItem {
  id: number;
  title: string;
  description: string;
  type: ItemType;
  priority: Priority;
  status: Status;
  teamId: number;
  assigneeId: number | null;
  createdById: number;
  dueDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredEvent {
  id: number;
  itemId: number;
  type: ActivityType;
  actorId: number;
  from: string | null;
  to: string | null;
  body: string | null;
  createdAt: string;
}

export interface MockDb {
  schema: number;
  users: StoredUser[];
  teams: TeamRef[];
  items: StoredItem[];
  events: StoredEvent[];
  idempotency: Record<string, { hash: string; response: WorkItem }>;
  nextItemId: number;
  nextEventId: number;
}

export const SCHEMA_VERSION = 1;
export const DEMO_PASSWORD = 'Password@123';

const TEAMS: TeamRef[] = [
  { id: 1, name: 'Payments' },
  { id: 2, name: 'Support' },
  { id: 3, name: 'Compliance' },
  { id: 4, name: 'Platform' },
];

const u = (
  id: number,
  name: string,
  email: string,
  memberships: [number, Role][],
): StoredUser => ({
  id,
  name,
  email,
  password: DEMO_PASSWORD,
  memberships: memberships.map(([teamId, role]) => ({ teamId, role })),
});

export const DEMO_USERS: StoredUser[] = [
  u(1, 'Aarav Admin', 'admin@ops.test', [[1, 'admin'], [2, 'admin'], [3, 'admin'], [4, 'admin']]),
  u(2, 'Priya Lead', 'priya.lead@ops.test', [[1, 'lead'], [2, 'member']]),
  u(3, 'Rohan Lead', 'rohan.lead@ops.test', [[2, 'lead'], [3, 'viewer']]),
  u(4, 'Neha Lead', 'neha.lead@ops.test', [[3, 'lead'], [4, 'member']]),
  u(5, 'Karan Lead', 'karan.lead@ops.test', [[4, 'lead']]),
  u(6, 'Ishita Member', 'ishita@ops.test', [[1, 'member'], [2, 'member']]),
  u(7, 'Vikram Member', 'vikram@ops.test', [[1, 'member']]),
  u(8, 'Ananya Member', 'ananya@ops.test', [[3, 'member'], [4, 'member']]),
  u(9, 'Sahil Member', 'sahil@ops.test', [[2, 'member']]),
  u(10, 'Meera Viewer', 'meera@ops.test', [[1, 'viewer'], [2, 'viewer']]),
];

// ---------- deterministic pseudo-random helpers (same data on every fresh start) ----------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: readonly T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)] as T;
}

function weighted<T>(entries: readonly (readonly [T, number])[], rnd: () => number): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [value, w] of entries) {
    r -= w;
    if (r <= 0) return value;
  }
  return entries[entries.length - 1]![0];
}

const TITLES: Record<ItemType, string[]> = {
  incident: [
    'Checkout API returning intermittent 5xx errors',
    'Database replica lag above threshold',
    'SSO login failures for enterprise tenants',
    'Webhook deliveries delayed by more than 10 minutes',
    'Search service latency spike in the evening',
    'Background worker queue not draining',
  ],
  customer_issue: [
    'Customer cannot download monthly statement',
    'Duplicate notification emails received',
    'Refund shown as pending for 7 days',
    'Account locked after password reset',
    'Mobile app crashes on opening invoices',
    'Wrong currency displayed on receipt',
  ],
  payment: [
    'Settlement mismatch for yesterday’s batch',
    'Chargeback evidence due this week',
    'Payout stuck in processing for merchant',
    'UPI collect requests timing out',
    'Reconcile failed card transactions',
    'Fee rounding difference on invoices',
  ],
  compliance: [
    'KYC documents expiring for 14 merchants',
    'Quarterly audit evidence collection',
    'Data retention review for support tickets',
    'Update privacy notice wording',
    'Access review for production database',
    'Sanctions screening alert needs review',
  ],
  task: [
    'Update on-call runbook after last incident',
    'Archive resolved items older than 90 days',
    'Prepare weekly operations summary',
    'Clean up unused alert rules',
    'Document escalation path for payments',
    'Review dashboard filters with the team',
  ],
};

const TYPE_BY_TEAM: Record<number, ItemType[]> = {
  1: ['payment', 'payment', 'incident', 'task'],
  2: ['customer_issue', 'customer_issue', 'customer_issue', 'task', 'incident'],
  3: ['compliance', 'compliance', 'task'],
  4: ['incident', 'incident', 'task'],
};

const DESCRIPTIONS = [
  'Reported by the on-call engineer. Needs investigation and a clear owner.',
  'Several users have reported this over the last two days. Logs attached in the ticket.',
  'Raised during the weekly review. Please confirm impact before changing anything.',
  'Blocking a downstream team. Update the thread when there is progress.',
  'Low risk, but it keeps coming back. Worth fixing properly this time.',
];

const COMMENTS = [
  'Looking into this now.',
  'Reproduced it on staging. Checking the logs.',
  'Waiting for a reply from the customer.',
  'Shared the findings in the team channel.',
  'This looks related to last week’s change.',
  'Fix is ready, needs a review.',
];

const ORDER: Status[] = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function dateOnly(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function createSeedDb(now: number = Date.now(), itemCount = 520): MockDb {
  const rnd = mulberry32(20261016);
  const users = DEMO_USERS.map((x) => ({ ...x, memberships: x.memberships.map((m) => ({ ...m })) }));
  const userName = (id: number) => users.find((x) => x.id === id)?.name ?? 'Unknown';

  const workers = (teamId: number) =>
    users.filter((x) => x.memberships.some((m) => m.teamId === teamId && m.role !== 'viewer'));
  const leads = (teamId: number) =>
    users.filter((x) => x.memberships.some((m) => m.teamId === teamId && (m.role === 'lead' || m.role === 'admin')));

  const items: StoredItem[] = [];
  const events: StoredEvent[] = [];
  let nextEventId = 1;

  const spanStart = now - 60 * DAY;
  const step = (60 * DAY) / itemCount;

  for (let id = 1; id <= itemCount; id++) {
    const teamId = weighted<number>([[1, 3], [2, 4], [3, 2], [4, 3]], rnd);
    const type = pick(TYPE_BY_TEAM[teamId] ?? ['task'], rnd);
    const priority = weighted<Priority>([['low', 25], ['medium', 40], ['high', 25], ['urgent', 10]], rnd);
    const status = weighted<Status>(
      [['open', 30], ['in_progress', 25], ['awaiting_approval', 15], ['resolved', 15], ['closed', 15]],
      rnd,
    );

    const team = workers(teamId);
    const creator = pick(team, rnd);
    let assigneeId: number | null = null;
    if (status !== 'open') assigneeId = pick(team, rnd).id;
    else if (rnd() < 0.25) assigneeId = pick(team, rnd).id;

    const createdMs = Math.min(now, Math.round(spanStart + id * step));
    const at = (hoursAfter: number) => new Date(Math.min(now, createdMs + hoursAfter * HOUR)).toISOString();

    const evs: Omit<StoredEvent, 'id'>[] = [];
    const push = (
      type_: ActivityType,
      actorId: number,
      hoursAfter: number,
      from: string | null = null,
      to: string | null = null,
      body: string | null = null,
    ) => evs.push({ itemId: id, type: type_, actorId, from, to, body, createdAt: at(hoursAfter) });

    push('created', creator.id, 0);
    if (assigneeId !== null) push('assignee_changed', assigneeId, 1, null, userName(assigneeId));

    const reached = ORDER.indexOf(status);
    let changes = assigneeId !== null ? 1 : 0;
    for (let i = 1; i <= reached; i++) {
      const lead = pick(leads(teamId), rnd);
      const actor = i <= 2 ? (assigneeId ?? lead.id) : lead.id;
      push('status_changed', actor, 2 + i * 3, ORDER[i - 1]!, ORDER[i]!);
      changes++;
    }

    const commentCount = rnd() < 0.5 ? 0 : rnd() < 0.7 ? 1 : 2;
    for (let c = 0; c < commentCount; c++) {
      push('comment', pick(team, rnd).id, 1.5 + c * 4, null, null, pick(COMMENTS, rnd));
    }

    evs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const e of evs) events.push({ id: nextEventId++, ...e });

    const lastChange = [...evs].reverse().find((e) => e.type !== 'comment');
    items.push({
      id,
      title: pick(TITLES[type], rnd),
      description: pick(DESCRIPTIONS, rnd),
      type,
      priority,
      status,
      teamId,
      assigneeId,
      createdById: creator.id,
      dueDate: rnd() < 0.55 ? dateOnly(createdMs + Math.round(3 + rnd() * 17) * DAY) : null,
      version: 1 + changes,
      createdAt: new Date(createdMs).toISOString(),
      updatedAt: lastChange?.createdAt ?? new Date(createdMs).toISOString(),
    });
  }

  return {
    schema: SCHEMA_VERSION,
    users,
    teams: TEAMS.map((t) => ({ ...t })),
    items,
    events,
    idempotency: {},
    nextItemId: itemCount + 1,
    nextEventId,
  };
}
