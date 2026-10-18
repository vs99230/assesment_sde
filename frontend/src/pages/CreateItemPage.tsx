import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { isApiError, errorMessage } from '../api/errors';
import { useCurrentUser } from '../auth/AuthContext';
import { Banner, EmptyState } from '../components/Feedback';
import { useCreateItem, useTeamMembers } from '../hooks/queries';
import { ITEM_TYPES, PRIORITIES, PRIORITY_LABEL, ROLE_LABEL, TYPE_LABEL } from '../lib/labels';
import { canCreateInTeam, isLead } from '../lib/rules';
import { validateCreateInput, type FieldErrors } from '../lib/validation';
import type { CreateItemInput, ItemType, Priority } from '../types';

function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export default function CreateItemPage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const create = useCreateItem();

  const teams = user.memberships.filter((m) => canCreateInTeam(m.role));

  const [teamId, setTeamId] = useState<number>(teams[0]?.teamId ?? 0);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<ItemType>('task');
  const [priority, setPriority] = useState<Priority>('medium');
  const [dueDate, setDueDate] = useState('');
  const [assignee, setAssignee] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  // One idempotency key per distinct request: a double-click or a retry re-sends the SAME key,
  // so the server creates a single item. Changing the data starts a new request (new key).
  const lastRequest = useRef<{ fingerprint: string; key: string } | null>(null);

  const selected = teams.find((t) => t.teamId === teamId);
  const canAssign = isLead(selected?.role);
  const members = useTeamMembers(canAssign ? teamId : null);
  const assignable = (members.data ?? []).filter((m) => m.role !== 'viewer');

  if (teams.length === 0) {
    return (
      <EmptyState
        title="You can’t create items yet"
        message="Creating items needs the Member role (or higher) in at least one team."
        action={
          <Link to="/items" className="btn">
            Back to items
          </Link>
        }
      />
    );
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return; // ignore double clicks while a request is in flight

    const input: CreateItemInput = {
      title: title.trim(),
      description: description.trim(),
      type,
      priority,
      teamId,
      dueDate: dueDate || null,
      assigneeId: canAssign && assignee ? Number(assignee) : null,
    };

    const found = validateCreateInput(input);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    const fingerprint = JSON.stringify(input);
    if (!lastRequest.current || lastRequest.current.fingerprint !== fingerprint) {
      lastRequest.current = { fingerprint, key: newKey() };
    }

    create.mutate(
      { input, key: lastRequest.current.key },
      {
        onSuccess: (item) => navigate(`/items/${item.id}`),
        onError: (err) => {
          if (isApiError(err) && err.details?.fields) setErrors(err.details.fields);
          setFormError(errorMessage(err));
        },
      },
    );
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>New item</h1>
          <p className="muted">Create a work item for one of your teams.</p>
        </div>
      </div>

      <form className="card form-card" onSubmit={onSubmit} noValidate>
        {formError && <Banner tone="error">{formError}</Banner>}

        <div className="field">
          <label htmlFor="c-title">Title</label>
          <input
            id="c-title"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={!!errors.title}
            autoFocus
          />
          {errors.title && <p className="field-error">{errors.title}</p>}
        </div>

        <div className="field">
          <label htmlFor="c-desc">Description</label>
          <textarea
            id="c-desc"
            rows={5}
            value={description}
            maxLength={4000}
            onChange={(e) => setDescription(e.target.value)}
            aria-invalid={!!errors.description}
          />
          {errors.description && <p className="field-error">{errors.description}</p>}
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="c-team">Team</label>
            <select
              id="c-team"
              value={teamId}
              onChange={(e) => {
                setTeamId(Number(e.target.value));
                setAssignee('');
              }}
            >
              {teams.map((m) => (
                <option key={m.teamId} value={m.teamId}>
                  {m.teamName} ({ROLE_LABEL[m.role]})
                </option>
              ))}
            </select>
            {errors.teamId && <p className="field-error">{errors.teamId}</p>}
          </div>

          <div className="field">
            <label htmlFor="c-type">Type</label>
            <select id="c-type" value={type} onChange={(e) => setType(e.target.value as ItemType)}>
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            {errors.type && <p className="field-error">{errors.type}</p>}
          </div>

          <div className="field">
            <label htmlFor="c-priority">Priority</label>
            <select id="c-priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
            {errors.priority && <p className="field-error">{errors.priority}</p>}
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="c-due">Due date (optional)</label>
            <input id="c-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            {errors.dueDate && <p className="field-error">{errors.dueDate}</p>}
          </div>

          {canAssign && (
            <div className="field">
              <label htmlFor="c-assignee">Assign to (optional)</label>
              <select id="c-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Leave unassigned</option>
                {assignable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {errors.assigneeId && <p className="field-error">{errors.assigneeId}</p>}
            </div>
          )}
        </div>

        <div className="button-row">
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create item'}
          </button>
          <Link to="/items" className="btn">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
