import { useRef, useState, type FormEvent } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import { isApiError } from '../api/errors';
import { useTeamMembers } from '../hooks/queries';
import { PRIORITIES, PRIORITY_LABEL } from '../lib/labels';
import { canReassign } from '../lib/rules';
import { validateUpdateInput, type FieldErrors } from '../lib/validation';
import type { Role, UpdateItemInput, WorkItem } from '../types';

interface Props {
  item: WorkItem;
  role: Role | null;
  update: UseMutationResult<WorkItem, Error, UpdateItemInput>;
  onClose: () => void;
}

export default function EditItemForm({ item, role, update, onClose }: Props) {
  // The version the user was looking at when they opened the form. If someone else
  // changes the item meanwhile, saving fails with a 409 instead of overwriting them.
  const baseVersion = useRef(item.version).current;

  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [priority, setPriority] = useState(item.priority);
  const [dueDate, setDueDate] = useState(item.dueDate ?? '');
  const [assignee, setAssignee] = useState(item.assignee ? String(item.assignee.id) : '');
  const [errors, setErrors] = useState<FieldErrors>({});

  const reassignable = canReassign(role);
  const members = useTeamMembers(reassignable ? item.team.id : null);
  const assignable = (members.data ?? []).filter((m) => m.role !== 'viewer');

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (update.isPending) return;

    const input: UpdateItemInput = { version: baseVersion };
    if (title.trim() !== item.title) input.title = title;
    if (description.trim() !== item.description) input.description = description;
    if (priority !== item.priority) input.priority = priority;
    if ((dueDate || null) !== item.dueDate) input.dueDate = dueDate || null;
    if (reassignable && assignee !== '' && Number(assignee) !== item.assignee?.id) {
      input.assigneeId = Number(assignee);
    }

    const found = validateUpdateInput(input);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    if (Object.keys(input).length === 1) {
      onClose(); // nothing changed
      return;
    }

    update.mutate(input, {
      onSuccess: onClose,
      onError: (err) => {
        if (isApiError(err) && err.code === 'VERSION_CONFLICT') onClose(); // latest copy is already shown
        else if (isApiError(err) && err.details?.fields) setErrors(err.details.fields);
      },
    });
  };

  return (
    <form className="card edit-form" onSubmit={onSubmit} noValidate aria-label="Edit item">
      <h2>Edit item</h2>

      <div className="field">
        <label htmlFor="e-title">Title</label>
        <input
          id="e-title"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          aria-invalid={!!errors.title}
        />
        {errors.title && <p className="field-error">{errors.title}</p>}
      </div>

      <div className="field">
        <label htmlFor="e-desc">Description</label>
        <textarea
          id="e-desc"
          rows={4}
          value={description}
          maxLength={4000}
          onChange={(e) => setDescription(e.target.value)}
          aria-invalid={!!errors.description}
        />
        {errors.description && <p className="field-error">{errors.description}</p>}
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor="e-priority">Priority</label>
          <select id="e-priority" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="e-due">Due date</label>
          <input id="e-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          {errors.dueDate && <p className="field-error">{errors.dueDate}</p>}
        </div>
        {reassignable && (
          <div className="field">
            <label htmlFor="e-assignee">Assignee</label>
            <select id="e-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              {item.assignee === null && <option value="">Unassigned</option>}
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
        <button type="submit" className="btn btn-primary" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={update.isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
