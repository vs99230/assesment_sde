import { Link } from 'react-router-dom';
import { useCurrentUser } from '../auth/AuthContext';
import { PriorityBadge } from '../components/Badges';
import { ErrorState, Spinner } from '../components/Feedback';
import { useDashboard } from '../hooks/queries';
import { errorMessage } from '../api/errors';
import { formatDueDate, isOverdue } from '../lib/format';
import { itemCode } from '../lib/labels';
import type { DashboardSection, DashboardView } from '../types';

interface SectionProps {
  title: string;
  hint: string;
  view: DashboardView;
  section: DashboardSection;
  emptyText: string;
}

function Section({ title, hint, view, section, emptyText }: SectionProps) {
  return (
    <section className="card dash-card" aria-labelledby={`dash-${view}`}>
      <div className="dash-head">
        <div>
          <h2 id={`dash-${view}`}>{title}</h2>
          <p className="muted small">{hint}</p>
        </div>
        <span className="count-pill" aria-label={`${section.total} items`}>
          {section.total}
        </span>
      </div>

      {section.items.length === 0 ? (
        <p className="muted empty-line">{emptyText}</p>
      ) : (
        <ul className="dash-list">
          {section.items.map((item) => (
            <li key={item.id}>
              <Link to={`/items/${item.id}`} className="dash-row">
                <span className="dash-row-main">
                  <span className="muted small">
                    {itemCode(item.id)} · {item.team.name}
                  </span>
                  <span className="dash-title">{item.title}</span>
                </span>
                <span className="dash-row-side">
                  <PriorityBadge priority={item.priority} />
                  <span className={isOverdue(item.dueDate, item.status) ? 'overdue small' : 'muted small'}>
                    {item.dueDate ? `Due ${formatDueDate(item.dueDate)}` : 'No due date'}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {section.total > section.items.length && (
        <Link className="view-all" to={`/items?view=${view}`}>
          View all {section.total} →
        </Link>
      )}
    </section>
  );
}

export default function DashboardPage() {
  const user = useCurrentUser();
  const { data, isPending, isError, error, refetch } = useDashboard();

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Hi, {user.name.split(' ')[0]}</h1>
          <p className="muted">What needs attention right now.</p>
        </div>
      </div>

      {isPending && <Spinner label="Loading dashboard…" />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />}

      {data && (
        <div className="dash-grid">
          <Section
            title="Assigned to me"
            hint="Open work that is yours (not yet resolved)."
            view="assigned_to_me"
            section={data.assignedToMe}
            emptyText="Nothing assigned to you. Claim something from All items."
          />
          <Section
            title="Unassigned urgent"
            hint="Urgent items nobody has picked up yet."
            view="unassigned_urgent"
            section={data.unassignedUrgent}
            emptyText="No unassigned urgent items. Nice."
          />
          <Section
            title="Awaiting my approval"
            hint="Items waiting for a Lead decision in your teams."
            view="awaiting_my_approval"
            section={data.awaitingMyApproval}
            emptyText="Nothing is waiting for your approval."
          />
        </div>
      )}
    </div>
  );
}
