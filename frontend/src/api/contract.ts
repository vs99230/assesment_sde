import type {
  ActivityEvent,
  CreateItemInput,
  Dashboard,
  ItemFilters,
  LoginResult,
  Page,
  Status,
  TeamMember,
  UpdateItemInput,
  User,
  WorkItem,
} from '../types';

/**
 * The single interface the UI talks to. Two implementations exist:
 *  - mock/mockApi.ts  (VITE_USE_MOCK=true)
 *  - http.ts          (VITE_USE_MOCK=false)
 * Both must behave exactly as described in docs/API_CONTRACT.md.
 */
export interface Api {
  login(email: string, password: string): Promise<LoginResult>;
  me(): Promise<User>;
  teamMembers(teamId: number): Promise<TeamMember[]>;

  dashboard(): Promise<Dashboard>;
  listItems(filters: ItemFilters, cursor: string | null, limit: number): Promise<Page<WorkItem>>;
  getItem(id: number): Promise<WorkItem>;
  createItem(input: CreateItemInput, idempotencyKey: string): Promise<WorkItem>;
  updateItem(id: number, input: UpdateItemInput): Promise<WorkItem>;
  claimItem(id: number): Promise<WorkItem>;
  transitionItem(id: number, to: Status, version: number): Promise<WorkItem>;

  listActivity(id: number, cursor: string | null, limit: number): Promise<Page<ActivityEvent>>;
  addComment(id: number, body: string): Promise<ActivityEvent>;
}
