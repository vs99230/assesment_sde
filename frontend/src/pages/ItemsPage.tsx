import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useCurrentUser } from '../auth/AuthContext';
import { EmptyState, ErrorState, Spinner } from '../components/Feedback';
import ItemTable from '../components/ItemTable';
import { useItemsInfinite } from '../hooks/queries';
import { errorMessage } from '../api/errors';
import { ITEM_TYPES, PRIORITIES, PRIORITY_LABEL, STATUS_LABEL, STATUSES, TYPE_LABEL } from '../lib/labels';
import { canCreateInTeam, roleInTeam } from '../lib/rules';
import type { DashboardView, ItemFilters } from '../types';

const VIEWS: readonly DashboardView[] = ['assigned_to_me', 'unassigned_urgent', 'awaiting_my_approval'];
const VIEW_LABEL: Record<DashboardView, string> = {
  assigned_to_me: 'Assigned to me',
  unassigned_urgent: 'Unassigned urgent',
  awaiting_my_approval: 'Awaiting my approval',
};

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export default function ItemsPage() {
  const user = useCurrentUser();
  const [params, setParams] = useSearchParams();

  const filters: ItemFilters = useMemo(() => {
    const team = Number(params.get('teamId'));
    const assignee = params.get('assignee');
    return {
      status: oneOf(params.get('status'), STATUSES),
      priority: oneOf(params.get('priority'), PRIORITIES),
      type: oneOf(params.get('type'), ITEM_TYPES),
      view: oneOf(params.get('view'), VIEWS),
      teamId: Number.isInteger(team) && team > 0 ? team : undefined,
      assignee: assignee === 'me' || assignee === 'unassigned' ? assignee : undefined,
      q: params.get('q')?.trim() || undefined,
    };
  }, [params]);

  const setParam = (name: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(name, value);
        else next.delete(name);
        return next;
      },
      { replace: true },
    );

  // Search box: type freely, URL (and the query) updates 350 ms after you stop typing.
  const [qInput, setQInput] = useState(filters.q ?? '');
  const urlQ = useRef(filters.q ?? '');
  urlQ.current = filters.q ?? '';
  useEffect(() => {
    setQInput(filters.q ?? '');
  }, [filters.q]);
  useEffect(() => {
    const timer = setTimeout(() => {
      const wanted = qInput.trim();
      if (wanted !== urlQ.current) {
        setParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            if (wanted) next.set('q', wanted);
            else next.delete('q');
            return next;
          },
          { replace: true },
        );
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [qInput, setParams]);

  const { data, isPending, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage, isFetching } =
    useItemsInfinite(filters);

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const hasFilters = Array.from(params.keys()).length > 0;
  const canCreate = user.memberships.some((m) => canCreateInTeam(m.role));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>All items</h1>
          <p className="muted">Only items from your teams are shown.</p>
        </div>
        {canCreate && (
          <Link to="/items/new" className="btn btn-primary">
            New item
          </Link>
        )}
      </div>

      {filters.view && (
        <div className="chip-row">
          <span className="chip">
            View: {VIEW_LABEL[filters.view]}
            <button type="button" aria-label="Remove view filter" onClick={() => setParam('view', '')}>
              ×
            </button>
          </span>
        </div>
      )}

      <div className="card filters" role="search">
        <div className="field grow">
          <label htmlFor="f-q">Search</label>
          <input
            id="f-q"
            type="search"
            placeholder="Title, description or OPS-123"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select id="f-status" value={filters.status ?? ''} onChange={(e) => setParam('status', e.target.value)}>
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-priority">Priority</label>
          <select
            id="f-priority"
            value={filters.priority ?? ''}
            onChange={(e) => setParam('priority', e.target.value)}
          >
            <option value="">Any</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-type">Type</label>
          <select id="f-type" value={filters.type ?? ''} onChange={(e) => setParam('type', e.target.value)}>
            <option value="">Any</option>
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-team">Team</label>
          <select id="f-team" value={filters.teamId ?? ''} onChange={(e) => setParam('teamId', e.target.value)}>
            <option value="">All my teams</option>
            {user.memberships.map((m) => (
              <option key={m.teamId} value={m.teamId}>
                {m.teamName} ({roleInTeam(user, m.teamId)})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-assignee">Assignee</label>
          <select
            id="f-assignee"
            value={filters.assignee ?? ''}
            onChange={(e) => setParam('assignee', e.target.value)}
          >
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="unassigned">Unassigned</option>
          </select>
        </div>
        {hasFilters && (
          <div className="field">
            <label aria-hidden="true">&nbsp;</label>
            <button type="button" className="btn" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              Clear filters
            </button>
          </div>
        )}
      </div>

      {isPending && <Spinner label="Loading items…" />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />}

      {!isPending && !isError && items.length === 0 && (
        <EmptyState
          title="No items found"
          message={hasFilters ? 'Try removing a filter or searching for something else.' : 'There are no items yet.'}
        />
      )}

      {items.length > 0 && (
        <>
          <ItemTable items={items} />
          <div className="list-footer">
            <span className="muted small" aria-live="polite">
              Showing {items.length} item{items.length === 1 ? '' : 's'}
              {isFetching && !isFetchingNextPage ? ' · updating…' : ''}
            </span>
            {hasNextPage && (
              <button type="button" className="btn" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
