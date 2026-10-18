import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { clearToken, setToken } from '../api/session';
import { resetMockDb } from '../api/mock/db';
import { mockApi, mockTools } from '../api/mock/mockApi';
import { DEMO_PASSWORD } from '../api/mock/seed';
import type { CreateItemInput, WorkItem } from '../types';

async function loginAs(email: string): Promise<void> {
  const res = await mockApi.login(email, DEMO_PASSWORD);
  setToken(res.token);
}

async function expectApiError(promise: Promise<unknown>, status: number, code?: string): Promise<ApiError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    const err = e as ApiError;
    expect(err.status).toBe(status);
    if (code) expect(err.code).toBe(code);
    return err;
  }
  throw new Error('Expected the call to fail, but it succeeded');
}

const baseInput: CreateItemInput = {
  title: 'Test item for payments',
  description: 'Created by an automated test.',
  type: 'task',
  priority: 'medium',
  teamId: 1,
  dueDate: null,
  assigneeId: null,
};

async function firstOpenUnassigned(teamId = 1): Promise<WorkItem> {
  const page = await mockApi.listItems({ status: 'open', assignee: 'unassigned', teamId }, null, 100);
  const item = page.items[0];
  if (!item) throw new Error('seed has no open unassigned item');
  return item;
}

beforeEach(() => {
  clearToken();
  resetMockDb();
});

describe('authentication', () => {
  it('rejects a wrong password', async () => {
    await expectApiError(mockApi.login('admin@ops.test', 'nope'), 401, 'UNAUTHENTICATED');
  });

  it('rejects calls without a token', async () => {
    await expectApiError(mockApi.dashboard(), 401, 'UNAUTHENTICATED');
  });

  it('returns the signed-in user with team roles', async () => {
    await loginAs('priya.lead@ops.test');
    const me = await mockApi.me();
    expect(me.memberships.find((m) => m.teamId === 1)?.role).toBe('lead');
  });
});

describe('authorization', () => {
  it('hides items of other teams (404, not 403)', async () => {
    await loginAs('vikram@ops.test'); // Payments member only
    const all = await mockApi.listItems({}, null, 100);
    expect(all.items.every((i) => i.team.id === 1)).toBe(true);

    await loginAs('admin@ops.test');
    const supportItem = (await mockApi.listItems({ teamId: 2 }, null, 1)).items[0]!;

    await loginAs('vikram@ops.test');
    await expectApiError(mockApi.getItem(supportItem.id), 404, 'NOT_FOUND');
    await expectApiError(mockApi.claimItem(supportItem.id), 404, 'NOT_FOUND');
  });

  it('stops viewers from creating, claiming or commenting', async () => {
    await loginAs('meera@ops.test'); // Viewer in Payments and Support
    await expectApiError(mockApi.createItem(baseInput, 'k-viewer'), 403, 'FORBIDDEN');
    const item = await firstOpenUnassigned();
    await expectApiError(mockApi.claimItem(item.id), 403, 'FORBIDDEN');
    await expectApiError(mockApi.addComment(item.id, 'hello'), 403, 'FORBIDDEN');
  });
});

describe('claim (only one winner)', () => {
  it('lets the first user win and rejects the second with 409', async () => {
    await loginAs('ishita@ops.test');
    const item = await firstOpenUnassigned();
    const claimed = await mockApi.claimItem(item.id);
    expect(claimed.assignee?.name).toBe('Ishita Member');
    expect(claimed.version).toBe(item.version + 1);

    await loginAs('vikram@ops.test');
    const err = await expectApiError(mockApi.claimItem(item.id), 409, 'ALREADY_CLAIMED');
    expect(err.details?.latest?.assignee?.name).toBe('Ishita Member');
  });

  it('handles two simultaneous claims: exactly one succeeds', async () => {
    await loginAs('ishita@ops.test');
    const item = await firstOpenUnassigned();
    const ishitaToken = (await mockApi.login('ishita@ops.test', DEMO_PASSWORD)).token;
    const vikramToken = (await mockApi.login('vikram@ops.test', DEMO_PASSWORD)).token;

    setToken(ishitaToken);
    const first = mockApi.claimItem(item.id);
    setToken(vikramToken);
    const second = mockApi.claimItem(item.id);

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

describe('optimistic locking', () => {
  it('rejects an edit made on a stale version and changes nothing', async () => {
    await loginAs('priya.lead@ops.test');
    const item = await firstOpenUnassigned();

    mockTools.simulateExternalChange(item.id); // version +1 behind our back
    const err = await expectApiError(
      mockApi.updateItem(item.id, { version: item.version, title: 'My stale edit' }),
      409,
      'VERSION_CONFLICT',
    );
    expect(err.details?.latest?.version).toBe(item.version + 1);
    expect((await mockApi.getItem(item.id)).title).toBe(item.title);
  });

  it('accepts an edit on the current version and bumps it once', async () => {
    await loginAs('priya.lead@ops.test');
    const item = await firstOpenUnassigned();
    const updated = await mockApi.updateItem(item.id, {
      version: item.version,
      title: 'A better title',
      priority: 'high',
    });
    expect(updated.title).toBe('A better title');
    expect(updated.priority).toBe('high');
    expect(updated.version).toBe(item.version + 1);
  });

  it('rejects a workflow move on a stale version', async () => {
    await loginAs('priya.lead@ops.test');
    const claimed = await mockApi.claimItem((await firstOpenUnassigned()).id);
    await expectApiError(mockApi.transitionItem(claimed.id, 'in_progress', claimed.version - 1), 409, 'VERSION_CONFLICT');
  });
});

describe('workflow rules', () => {
  it('walks the happy path with a Lead approving', async () => {
    await loginAs('priya.lead@ops.test');
    const claimed = await mockApi.claimItem((await firstOpenUnassigned()).id);
    const started = await mockApi.transitionItem(claimed.id, 'in_progress', claimed.version);
    const submitted = await mockApi.transitionItem(claimed.id, 'awaiting_approval', started.version);
    const resolved = await mockApi.transitionItem(claimed.id, 'resolved', submitted.version);
    const closed = await mockApi.transitionItem(claimed.id, 'closed', resolved.version);
    expect(closed.status).toBe('closed');
  });

  it('rejects jumps such as open -> closed', async () => {
    await loginAs('priya.lead@ops.test');
    const item = await firstOpenUnassigned();
    await expectApiError(mockApi.transitionItem(item.id, 'closed', item.version), 422, 'INVALID_TRANSITION');
  });

  it('only lets a Lead approve', async () => {
    await loginAs('ishita@ops.test'); // plain member in Payments
    const claimed = await mockApi.claimItem((await firstOpenUnassigned()).id);
    const started = await mockApi.transitionItem(claimed.id, 'in_progress', claimed.version);
    const submitted = await mockApi.transitionItem(claimed.id, 'awaiting_approval', started.version);
    await expectApiError(mockApi.transitionItem(claimed.id, 'resolved', submitted.version), 403, 'FORBIDDEN');

    await loginAs('priya.lead@ops.test');
    const approved = await mockApi.transitionItem(claimed.id, 'resolved', submitted.version);
    expect(approved.status).toBe('resolved');
  });

  it('records every change in the activity log', async () => {
    await loginAs('priya.lead@ops.test');
    const claimed = await mockApi.claimItem((await firstOpenUnassigned()).id);
    await mockApi.transitionItem(claimed.id, 'in_progress', claimed.version);
    await mockApi.addComment(claimed.id, 'On it.');
    const log = await mockApi.listActivity(claimed.id, null, 50);
    const types = log.items.map((e) => e.type);
    expect(types).toContain('assignee_changed');
    expect(types).toContain('status_changed');
    expect(types[0]).toBe('comment'); // newest first
  });
});

describe('idempotent create', () => {
  it('returns the same item for a repeated key and creates only one', async () => {
    await loginAs('ishita@ops.test');
    const before = (await mockApi.listItems({ q: baseInput.title }, null, 100)).items.length;
    const a = await mockApi.createItem(baseInput, 'key-123');
    const b = await mockApi.createItem(baseInput, 'key-123');
    expect(b.id).toBe(a.id);
    const after = (await mockApi.listItems({ q: baseInput.title }, null, 100)).items.length;
    expect(after).toBe(before + 1);
  });

  it('creates two items for two different keys', async () => {
    await loginAs('ishita@ops.test');
    const a = await mockApi.createItem(baseInput, 'key-a');
    const b = await mockApi.createItem(baseInput, 'key-b');
    expect(b.id).not.toBe(a.id);
  });

  it('rejects the same key with different data', async () => {
    await loginAs('ishita@ops.test');
    await mockApi.createItem(baseInput, 'key-x');
    await expectApiError(
      mockApi.createItem({ ...baseInput, title: 'A completely different title' }, 'key-x'),
      422,
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('validates input', async () => {
    await loginAs('ishita@ops.test');
    const err = await expectApiError(mockApi.createItem({ ...baseInput, title: 'ab' }, 'key-v'), 422, 'VALIDATION_ERROR');
    expect(err.details?.fields?.title).toBeTruthy();
  });
});

describe('lists, filters and pagination', () => {
  it('pages through everything without gaps or duplicates', async () => {
    await loginAs('admin@ops.test');
    const seen = new Set<number>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof mockApi.listItems>> = await mockApi.listItems({}, cursor, 50);
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 100);
    expect(seen.size).toBeGreaterThan(400);
    expect(cursor).toBeNull();
  });

  it('filters by status and searches by text', async () => {
    await loginAs('admin@ops.test');
    const open = await mockApi.listItems({ status: 'open' }, null, 100);
    expect(open.items.length).toBeGreaterThan(0);
    expect(open.items.every((i) => i.status === 'open')).toBe(true);

    const hit = open.items[0]!;
    const found = await mockApi.listItems({ q: hit.title.slice(0, 12) }, null, 100);
    expect(found.items.some((i) => i.id === hit.id)).toBe(true);
  });

  it('builds the three dashboard views', async () => {
    await loginAs('priya.lead@ops.test');
    const d = await mockApi.dashboard();
    expect(d.assignedToMe.items.every((i) => i.assignee?.name === 'Priya Lead')).toBe(true);
    expect(d.unassignedUrgent.items.every((i) => i.priority === 'urgent' && i.assignee === null)).toBe(true);
    expect(d.awaitingMyApproval.items.every((i) => i.status === 'awaiting_approval')).toBe(true);
  });
});
