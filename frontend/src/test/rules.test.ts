import { describe, expect, it } from 'vitest';
import { isOverdue } from '../lib/format';
import { allowedTransitions, canClaim, checkTransition } from '../lib/rules';
import { validateCreateInput, validateLogin } from '../lib/validation';
import type { WorkItem } from '../types';

const item = (patch: Partial<WorkItem> = {}): WorkItem => ({
  id: 1,
  title: 't',
  description: '',
  type: 'task',
  priority: 'medium',
  status: 'open',
  team: { id: 1, name: 'Payments' },
  assignee: null,
  createdBy: { id: 9, name: 'x' },
  dueDate: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
});

describe('workflow rules', () => {
  it('requires an assignee before work starts', () => {
    const r = checkTransition({ from: 'open', to: 'in_progress', role: 'member', userId: 1, assigneeId: null });
    expect(r.ok).toBe(false);
  });

  it('shows Approve only to Leads', () => {
    const waiting = item({ status: 'awaiting_approval', assignee: { id: 2, name: 'M' } });
    expect(allowedTransitions(waiting, 'member', 2)).toEqual([]);
    expect(allowedTransitions(waiting, 'lead', 3).sort()).toEqual(['in_progress', 'resolved']);
  });

  it('offers Claim only for open, unassigned items to Members and above', () => {
    expect(canClaim(item(), 'viewer')).toBe(false);
    expect(canClaim(item(), 'member')).toBe(true);
    expect(canClaim(item({ assignee: { id: 2, name: 'M' } }), 'member')).toBe(false);
    expect(canClaim(item({ status: 'in_progress' }), 'member')).toBe(false);
  });
});

describe('validation', () => {
  it('flags a short title and missing team', () => {
    const errors = validateCreateInput({ title: 'ab', type: 'task', priority: 'low', teamId: 0 });
    expect(errors.title).toBeTruthy();
    expect(errors.teamId).toBeTruthy();
  });

  it('accepts a good input', () => {
    expect(
      validateCreateInput({ title: 'Fix the thing', description: '', type: 'task', priority: 'low', teamId: 1 }),
    ).toEqual({});
  });

  it('checks the login form', () => {
    expect(validateLogin('nope', '').email).toBeTruthy();
    expect(validateLogin('a@b.co', 'x')).toEqual({});
  });
});

describe('dates', () => {
  const today = new Date(2026, 9, 16);
  it('marks past due dates overdue unless the item is finished', () => {
    expect(isOverdue('2026-10-15', 'open', today)).toBe(true);
    expect(isOverdue('2026-10-16', 'open', today)).toBe(false);
    expect(isOverdue('2026-10-15', 'resolved', today)).toBe(false);
    expect(isOverdue(null, 'open', today)).toBe(false);
  });
});
