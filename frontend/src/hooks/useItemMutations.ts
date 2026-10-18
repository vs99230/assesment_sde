import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { isApiError } from '../api/errors';
import type { Status, UpdateItemInput, User, WorkItem } from '../types';
import { keys } from './queries';

interface Snapshot {
  previous?: WorkItem;
}

/**
 * Write actions for one item: claim, workflow move, edit.
 * Claim and workflow moves are optimistic: the screen updates instantly, then is
 * rolled back (or replaced with the server's latest copy) if the server says no.
 */
export function useItemMutations(itemId: number, user: User, onError: (err: unknown) => void) {
  const qc = useQueryClient();
  const itemKey = keys.item(itemId);

  const refreshRelated = () => {
    qc.invalidateQueries({ queryKey: keys.activity(itemId) });
    qc.invalidateQueries({ queryKey: ['items'] });
    qc.invalidateQueries({ queryKey: keys.dashboard });
  };

  /** On a 409 the server sends its current copy; show it instead of our stale one. */
  const adoptLatest = (err: unknown) => {
    if (isApiError(err) && err.details?.latest) qc.setQueryData(itemKey, err.details.latest);
  };

  const optimistic = async (patch: (item: WorkItem) => WorkItem): Promise<Snapshot> => {
    await qc.cancelQueries({ queryKey: itemKey });
    const previous = qc.getQueryData<WorkItem>(itemKey);
    if (previous) qc.setQueryData<WorkItem>(itemKey, patch(previous));
    return { previous };
  };

  const rollback = (err: unknown, snapshot: Snapshot | undefined) => {
    if (snapshot?.previous) qc.setQueryData(itemKey, snapshot.previous);
    adoptLatest(err);
    onError(err);
  };

  const claim = useMutation<WorkItem, Error, void, Snapshot>({
    mutationFn: () => api.claimItem(itemId),
    onMutate: () =>
      optimistic((item) => ({
        ...item,
        assignee: { id: user.id, name: user.name },
        version: item.version + 1,
      })),
    onError: (err, _vars, snapshot) => rollback(err, snapshot),
    onSuccess: (item) => qc.setQueryData(itemKey, item),
    onSettled: refreshRelated,
  });

  const transition = useMutation<WorkItem, Error, { to: Status; version: number }, Snapshot>({
    mutationFn: ({ to, version }) => api.transitionItem(itemId, to, version),
    onMutate: ({ to }) => optimistic((item) => ({ ...item, status: to, version: item.version + 1 })),
    onError: (err, _vars, snapshot) => rollback(err, snapshot),
    onSuccess: (item) => qc.setQueryData(itemKey, item),
    onSettled: refreshRelated,
  });

  const update = useMutation<WorkItem, Error, UpdateItemInput>({
    mutationFn: (input) => api.updateItem(itemId, input),
    onError: (err) => {
      adoptLatest(err);
      onError(err);
    },
    onSuccess: (item) => qc.setQueryData(itemKey, item),
    onSettled: refreshRelated,
  });

  return { claim, transition, update };
}
