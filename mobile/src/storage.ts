import { parseDraft, parseWorkout, toWorkout } from './model.ts';
import type { Draft, Workout } from './model.ts';

export const DATABASE_NAME = 'djym.db';
const SCHEMA_VERSION = 3;
const DRAFT_KEY = 1;
export type Database = {
  execSync(sql: string): void;
  runSync(sql: string, ...params: (string | number)[]): void;
  getFirstSync<T>(sql: string, ...params: (string | number)[]): T | null;
  getAllSync<T>(sql: string, ...params: (string | number)[]): T[];
  withTransactionSync(action: () => void): void;
};

export function createStore(db: Database) {
  db.execSync('PRAGMA journal_mode = WAL;');
  const version = db.getFirstSync<{ user_version: number }>('PRAGMA user_version;')?.user_version ?? 0;
  if (version > SCHEMA_VERSION) throw new Error('unsupported_schema');
  if (version < 1) {
    db.withTransactionSync(() => {
      db.execSync(`
        CREATE TABLE workouts (id TEXT PRIMARY KEY NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE draft (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
    });
  }
  if (version < 2) {
    db.withTransactionSync(() => {
      db.execSync(`
        CREATE TABLE account_workouts (account TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
          generation INTEGER NOT NULL, pending INTEGER NOT NULL, deleted INTEGER NOT NULL,
          submitted INTEGER NOT NULL, error TEXT NOT NULL, PRIMARY KEY(account, id));
        CREATE TABLE account_drafts (account TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);
        PRAGMA user_version = 2;
      `);
    });
  }
  if (version < 3) {
    db.withTransactionSync(() => {
      db.execSync(`CREATE TABLE IF NOT EXISTS account_programs (account TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        generation INTEGER NOT NULL, pending INTEGER NOT NULL, deleted INTEGER NOT NULL, submitted INTEGER NOT NULL,
        error TEXT NOT NULL, PRIMARY KEY(account,id));
        CREATE TABLE IF NOT EXISTS program_drafts (account TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);
        PRAGMA user_version = 3;`);
    });
  }
  return {
    load(): { workouts: Workout[]; draft: Draft | null } {
      const workouts = db.getAllSync<{ payload: string }>('SELECT payload FROM workouts ORDER BY date DESC, rowid DESC;')
        .map(row => parseWorkout(row.payload));
      const row = db.getFirstSync<{ payload: string }>('SELECT payload FROM draft WHERE id = ?;', DRAFT_KEY);
      return { workouts, draft: row ? parseDraft(row.payload) : null };
    },
    // Small synchronous writes finish before the next edit, save, or navigation action.
    writeDraft(draft: Draft): void {
      db.runSync('INSERT INTO draft (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload;', DRAFT_KEY, JSON.stringify(draft));
    },
    clearDraft(): void {
      db.runSync('DELETE FROM draft WHERE id = ?;', DRAFT_KEY);
    },
    save(draft: Draft): Workout {
      const workout = toWorkout(draft);
      db.withTransactionSync(() => {
        db.runSync('INSERT INTO workouts (id, date, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET date = excluded.date, payload = excluded.payload;',
          workout.id, workout.date, JSON.stringify(workout));
        db.runSync('DELETE FROM draft WHERE id = ?;', DRAFT_KEY);
      });
      return workout;
    },
    remove(id: string): void {
      db.withTransactionSync(() => {
        db.runSync('DELETE FROM workouts WHERE id = ?;', id);
        db.runSync('DELETE FROM draft WHERE id = ?;', DRAFT_KEY);
      });
    },
  };
}
export type Store = ReturnType<typeof createStore>;
