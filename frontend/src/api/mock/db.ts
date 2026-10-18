import { createSeedDb, SCHEMA_VERSION, type MockDb } from './seed';

const STORAGE_KEY = 'ops.mock.db.v1';

let db: MockDb | null = null;

function storage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* storage blocked */
  }
  return null;
}

function load(): MockDb | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MockDb;
    if (parsed.schema !== SCHEMA_VERSION || !Array.isArray(parsed.items) || !Array.isArray(parsed.users)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Returns the in-memory mock database, loading (or seeding) it on first use. */
export function getDb(): MockDb {
  if (!db) {
    db = load() ?? createSeedDb();
    persist();
  }
  return db;
}

/** Saves the mock database so data survives a page refresh. Failures are ignored on purpose. */
export function persist(): void {
  if (!db) return;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    /* quota exceeded or storage blocked: keep working in memory */
  }
}

/** Throws away all changes and starts again from the seed data. */
export function resetMockDb(): void {
  db = createSeedDb();
  persist();
}
