import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { PAGE_SIZE } from '../config';
import type { ActivityEvent, CreateItemInput, ItemFilters, WorkItem } from '../types';

export const keys = {
  dashboard: ['dashboard'] as const,
  items: (filters: ItemFilters) => ['items', filters] as const,
  item: (id: number) => ['item', id] as const,
  activity: (id: number) => ['activity', id] as const,
  members: (teamId: number) => ['members', teamId] as const,
};

export function useDashboard() {
  return useQuery({
    queryKey: keys.dashboard,
    queryFn: () => api.dashboard(),
    refetchInterval: 30_000, // polling is enough, no websockets needed
  });
}

export function useItemsInfinite(filters: ItemFilters) {
  return useInfiniteQuery({
    queryKey: keys.items(filters),
    queryFn: ({ pageParam }) => api.listItems(filters, pageParam, PAGE_SIZE),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useItem(id: number) {
  return useQuery({
    queryKey: keys.item(id),
    queryFn: () => api.getItem(id),
    enabled: Number.isInteger(id) && id > 0,
  });
}

export function useActivity(id: number) {
  return useInfiniteQuery({
    queryKey: keys.activity(id),
    queryFn: ({ pageParam }) => api.listActivity(id, pageParam, 15),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useTeamMembers(teamId: number | null) {
  return useQuery({
    queryKey: keys.members(teamId ?? 0),
    queryFn: () => api.teamMembers(teamId as number),
    enabled: teamId !== null && teamId > 0,
    staleTime: 60_000,
  });
}

export function useCreateItem() {
  const qc = useQueryClient();
  return useMutation<WorkItem, Error, { input: CreateItemInput; key: string }>({
    mutationFn: ({ input, key }) => api.createItem(input, key),
    onSuccess: (item) => {
      qc.setQueryData(keys.item(item.id), item);
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: keys.dashboard });
    },
  });
}

export function useAddComment(itemId: number) {
  const qc = useQueryClient();
  return useMutation<ActivityEvent, Error, string>({
    mutationFn: (body) => api.addComment(itemId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.activity(itemId) }),
  });
}
