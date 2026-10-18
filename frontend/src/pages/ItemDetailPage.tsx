import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isApiError, errorMessage } from '../api/errors';
import ActivityFeed from '../components/ActivityFeed';
import { PriorityBadge, StatusBadge } from '../components/Badges';
import CommentBox from '../components/CommentBox';
import EditItemForm from '../components/EditItemForm';
import { Banner, ErrorState, Spinner } from '../components/Feedback';
import MockTools from '../components/MockTools';
import { useCurrentUser } from '../auth/AuthContext';
import { USE_MOCK } from '../config';
import { useItemMutations } from '../hooks/useItemMutations';
import { keys, useItem } from '../hooks/queries';
import { describeActionError, type Notice } from '../lib/describeError';
import { formatDateTime, formatDueDate, isOverdue } from '../lib/format';
import { itemCode, ROLE_LABEL, transitionLabel, TYPE_LABEL } from '../lib/labels';
import { allowedTransitions, canClaim, canComment, canEditItem, roleInTeam } from '../lib/rules';
import type { User } from '../types';

export default function ItemDetailPage() {
  const { id } = useParams();
  const user = useCurrentUser();
  const itemId = Number(id);

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return (
      <ErrorState
        title="Item not found"
        message="That link does not look right."
        onRetry={undefined}
      />
    );
  }
  return <ItemDetail key={itemId} itemId={itemId} user={user} />;
}

function ItemDetail({ itemId, user }: { itemId: number; user: User }) {
  const qc = useQueryClient();
  const itemQuery = useItem(itemId);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState(false);

  const { claim, transition, update } = useItemMutations(itemId, user, (err) => {
    setNotice(describeActionError(err));
    // A conflict means our copy was stale; whatever form was open is out of date too.
    if (isApiError(err) && (err.code === 'VERSION_CONFLICT' || err.code === 'ALREADY_CLAIMED')) {
      setEditing(false);
    }
  });

  const item = itemQuery.data;

  if (itemQuery.isPending) return <Spinner label="Loading item…" />;

  if (itemQuery.isError || !item) {
    const notFound = isApiError(itemQuery.error) && itemQuery.error.code === 'NOT_FOUND';
    return (
      <div>
        <p>
          <Link to="/items">← All items</Link>
        </p>
        <ErrorState
          title={notFound ? 'Item not found' : 'Could not load item'}
          message={
            notFound
              ? 'It may not exist, or it belongs to a team you are not part of.'
              : errorMessage(itemQuery.error)
          }
          onRetry={notFound ? undefined : () => void itemQuery.refetch()}
        />
      </div>
    );
  }

  const role = roleInTeam(user, item.team.id);
  const busy = claim.isPending || transition.isPending || update.isPending;
  const moves = allowedTransitions(item, role, user.id);
  const showClaim = canClaim(item, role);
  const showEdit = canEditItem(item, role, user.id);
  const readOnly = !showClaim && moves.length === 0 && !showEdit;

  const reload = async () => {
    setNotice(null);
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.item(itemId) }),
      qc.invalidateQueries({ queryKey: keys.activity(itemId) }),
    ]);
  };

  return (
    <div>
      <p>
        <Link to="/items">← All items</Link>
      </p>

      {notice && (
        <Banner
          tone={notice.tone}
          onDismiss={() => setNotice(null)}
          action={
            notice.tone === 'warning' ? (
              <button type="button" className="btn btn-small" onClick={() => void reload()}>
                Reload
              </button>
            ) : undefined
          }
        >
          {notice.message}
        </Banner>
      )}

      <div className="card detail-head">
        <div className="muted small">
          {itemCode(item.id)} · {TYPE_LABEL[item.type]} · {item.team.name}
        </div>
        <h1>{item.title}</h1>
        <div className="badge-row">
          <StatusBadge status={item.status} />
          <PriorityBadge priority={item.priority} />
          {itemQuery.isFetching && <span className="muted small">refreshing…</span>}
        </div>
        <p className="description">{item.description || <span className="muted">No description.</span>}</p>
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          <div className="card">
            <h2>Actions</h2>
            {readOnly ? (
              <p className="muted">
                {role === 'viewer'
                  ? 'You have the Viewer role in this team, so this item is read-only for you.'
                  : item.status === 'closed'
                    ? 'This item is closed.'
                    : 'There is nothing you can do on this item right now.'}
              </p>
            ) : (
              <div className="button-row">
                {showClaim && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => {
                      setNotice(null);
                      claim.mutate();
                    }}
                  >
                    {claim.isPending ? 'Claiming…' : 'Claim this item'}
                  </button>
                )}
                {moves.map((to) => (
                  <button
                    key={to}
                    type="button"
                    className={to === 'resolved' ? 'btn btn-primary' : 'btn'}
                    disabled={busy}
                    onClick={() => {
                      setNotice(null);
                      transition.mutate({ to, version: item.version });
                    }}
                  >
                    {transitionLabel(item.status, to)}
                  </button>
                ))}
                {showEdit && !editing && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      setNotice(null);
                      setEditing(true);
                    }}
                  >
                    Edit details
                  </button>
                )}
              </div>
            )}
            {item.status === 'awaiting_approval' && moves.length === 0 && (
              <p className="muted small">Waiting for a Lead of {item.team.name} to approve.</p>
            )}
          </div>

          {editing && (
            <EditItemForm
              item={item}
              role={role}
              update={update}
              onClose={() => setEditing(false)}
            />
          )}

          <div className="card">
            <h2>Activity</h2>
            {canComment(role) && <CommentBox itemId={itemId} />}
            <ActivityFeed itemId={itemId} />
          </div>
        </div>

        <aside className="detail-side">
          <div className="card">
            <h2>Details</h2>
            <dl className="meta">
              <dt>Assignee</dt>
              <dd>{item.assignee ? item.assignee.name : <span className="muted">Unassigned</span>}</dd>
              <dt>Created by</dt>
              <dd>{item.createdBy.name}</dd>
              <dt>Due</dt>
              <dd className={isOverdue(item.dueDate, item.status) ? 'overdue' : undefined}>
                {formatDueDate(item.dueDate)}
                {isOverdue(item.dueDate, item.status) && ' (overdue)'}
              </dd>
              <dt>Your role here</dt>
              <dd>{role ? ROLE_LABEL[role] : '—'}</dd>
              <dt>Created</dt>
              <dd>{formatDateTime(item.createdAt)}</dd>
              <dt>Updated</dt>
              <dd>{formatDateTime(item.updatedAt)}</dd>
              <dt>Version</dt>
              <dd>v{item.version}</dd>
            </dl>
          </div>
          {USE_MOCK && <MockTools itemId={itemId} />}
        </aside>
      </div>
    </div>
  );
}
