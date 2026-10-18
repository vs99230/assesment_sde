import { useMemo } from 'react';
import { errorMessage } from '../api/errors';
import { useActivity } from '../hooks/queries';
import { describeEvent } from '../lib/activity';
import { formatDateTime } from '../lib/format';
import { ErrorState, Spinner } from './Feedback';

export default function ActivityFeed({ itemId }: { itemId: number }) {
  const { data, isPending, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useActivity(itemId);
  const events = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  if (isPending) return <Spinner label="Loading activity…" />;
  if (isError) return <ErrorState title="Could not load activity" message={errorMessage(error)} onRetry={() => void refetch()} />;
  if (events.length === 0) return <p className="muted">No activity yet.</p>;

  return (
    <>
      <ol className="timeline">
        {events.map((ev) => (
          <li key={ev.id} className={`timeline-item${ev.type === 'comment' ? ' is-comment' : ''}`}>
            <div className="timeline-head">
              <strong>{ev.actor.name}</strong> <span>{describeEvent(ev)}</span>
              <time className="muted small" dateTime={ev.createdAt}>
                {formatDateTime(ev.createdAt)}
              </time>
            </div>
            {ev.type === 'comment' && ev.body && <p className="comment-body">{ev.body}</p>}
          </li>
        ))}
      </ol>
      {hasNextPage && (
        <button type="button" className="btn btn-small" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
          {isFetchingNextPage ? 'Loading…' : 'Show older activity'}
        </button>
      )}
    </>
  );
}
