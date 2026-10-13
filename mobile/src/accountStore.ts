import { createStore } from './storage.ts';
import type { Database } from './storage.ts';
import { parseDraft, parseWorkout, toWorkout, WORKOUT_TYPES } from './model.ts';
import type { Draft, Workout } from './model.ts';
import type { Ack, Session } from './api.ts';

export type Row = { workout: Workout; generation: number; pending: boolean; deleted: boolean; submitted: boolean; error: string };
export function accountKey(s: Pick<Session, 'apiURL' | 'userId'>): string { return JSON.stringify([s.apiURL, s.userId]); }
export function createAccountStore(db: Database, account: string) {
  const legacy = createStore(db);
  function rows(): Row[] {
    return db.getAllSync<{ payload: string; generation: number; pending: number; deleted: number; submitted: number; error: string }>(
      'SELECT * FROM account_workouts WHERE account = ? ORDER BY rowid DESC;', account).map(r => ({
        workout: parseWorkout(r.payload), generation: r.generation, pending: !!r.pending, deleted: !!r.deleted, submitted: !!r.submitted, error: r.error,
      }));
  }
  function put(r: Row) {
    db.runSync(`INSERT INTO account_workouts (account,id,payload,generation,pending,deleted,submitted,error) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(account,id) DO UPDATE SET payload=excluded.payload,generation=excluded.generation,pending=excluded.pending,
      deleted=excluded.deleted,submitted=excluded.submitted,error=excluded.error;`, account, r.workout.id, JSON.stringify(r.workout), r.generation, +r.pending, +r.deleted, +r.submitted, r.error);
  }
  function erase(id: string) { db.runSync('DELETE FROM account_workouts WHERE account = ? AND id = ?;', account, id); }
  function clearDraft() { db.runSync('DELETE FROM account_drafts WHERE account = ?;', account); }
  function writeDraft(d: Draft) {
    db.runSync('INSERT INTO account_drafts (account,payload) VALUES (?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload;', account, JSON.stringify(d));
  }
  function saveInside(draft: Draft): Workout {
    const current = rows().find(r => r.workout.id === draft.id);
    const workout = toWorkout({ ...draft, ...(current ? {
      remoteId: current.workout.remoteId, revision: current.workout.revision, source: current.workout.source, sourceRef: current.workout.sourceRef,
    } : {}), source: current?.workout.source ?? 'mobile', sourceRef: current?.workout.sourceRef ?? draft.id });
    // A local save does not accept a conflicting server revision.
    put({ workout, generation: (current?.generation ?? 0) + 1, pending: true, deleted: false, submitted: current?.submitted ?? false, error: current?.error ?? '' });
    return workout;
  }
  return {
    rows,
    load() {
      const d = db.getFirstSync<{ payload: string }>('SELECT payload FROM account_drafts WHERE account = ?;', account);
      return { workouts: rows().filter(r => !r.deleted).map(r => r.workout).sort((a,b) => b.date.localeCompare(a.date)), draft: d ? parseDraft(d.payload) : null };
    },
    writeDraft, clearDraft,
    save(draft: Draft): Workout {
      let result!: Workout;
      db.withTransactionSync(() => { result = saveInside(draft); clearDraft(); });
      return result;
    },
    remove(id: string) {
      db.withTransactionSync(() => {
        const r = rows().find(r => r.workout.id === id);
        if (r) {
          if (!r.workout.remoteId && !r.submitted) erase(id);
          else put({ ...r, generation: r.generation + 1, pending: true, deleted: true });
        }
        clearDraft();
      });
    },
    submitted(id: string) { const r = rows().find(r => r.workout.id === id); if (r) put({ ...r, submitted: true }); },
    acknowledge(snapshot: Row, ack: Ack | null) {
      db.withTransactionSync(() => {
        const current = rows().find(r => r.workout.id === snapshot.workout.id);
        if (!current) return;
        if (ack === null) { if (current.deleted) erase(current.workout.id); return; }
        const same = current.generation === snapshot.generation;
        put({ ...current, workout: { ...current.workout, remoteId: ack.workout_id, revision: ack.updated_at },
          pending: !same || current.deleted, error: '' });
        // Only refresh revision metadata in an active draft, never its editable content.
        const d = db.getFirstSync<{ payload: string }>('SELECT payload FROM account_drafts WHERE account = ?;', account);
        if (d) { const draft = parseDraft(d.payload); if (draft.id === current.workout.id) writeDraft({ ...draft, remoteId: ack.workout_id, revision: ack.updated_at }); }
      });
    },
    failure(snapshot: Row, error: string) {
      const r = rows().find(r => r.workout.id === snapshot.workout.id);
      if (r) put({ ...r, error });
    },
    merge(workouts: Workout[]) {
      db.withTransactionSync(() => {
        const d = db.getFirstSync<{ payload: string }>('SELECT payload FROM account_drafts WHERE account = ?;', account);
        const draftId = d ? parseDraft(d.payload).id : null;
        for (const w of workouts) {
          const r = rows().find(r => r.workout.remoteId === w.remoteId || (w.source === 'mobile' && r.workout.sourceRef === w.sourceRef));
          if (r?.pending) {
            if (!r.workout.remoteId && !r.error) put({ ...r, workout: { ...r.workout, remoteId: w.remoteId, revision: w.revision } });
          } else if (r?.workout.id !== draftId) put({ workout: { ...w, id: r?.workout.id ?? w.id }, generation: r?.generation ?? 0, pending: false, deleted: false, submitted: true, error: '' });
        }
        // A successful full snapshot can remove remote deletions, never local pending writes.
        for (const r of rows()) if (!r.pending && r.workout.id !== draftId && r.workout.remoteId && !workouts.some(w => w.remoteId === r.workout.remoteId)) erase(r.workout.id);
      });
    },
    resolve(id: string, server: Workout | null) {
      db.withTransactionSync(() => {
        const r = rows().find(r => r.workout.id === id);
        if (!r) return;
        if (server) put({ workout: { ...server, id }, generation: r.generation + 1, pending: false, deleted: false, submitted: true, error: '' });
        else erase(id);
        const d = db.getFirstSync<{ payload: string }>('SELECT payload FROM account_drafts WHERE account = ?;', account);
        if (d && parseDraft(d.payload).id === id) clearDraft();
      });
    },
    legacy() { return legacy.load(); },
    importLegacy(uuid: () => string) {
      db.withTransactionSync(() => {
        const data = legacy.load();
        const importedIds = new Map<string, string>();
        const normalize = (d: Draft): Draft => {
          let id = importedIds.get(d.id);
          if (!id) { id = uuid(); importedIds.set(d.id, id); }
          const title = WORKOUT_TYPES.find(t => t.toLowerCase() === d.title.trim().toLowerCase()) ?? '';
          return { ...d, id, title, notes: [!title ? d.title : '', d.notes].filter(Boolean).join('\n') };
        };
        for (const w of data.workouts) {
          saveInside(normalize({ ...w, exercises: w.exercises.map(e => ({ ...e, sets: e.sets.map(s => ({ ...s, kg: String(s.kg), reps: String(s.reps) })) })) }));
          db.runSync('DELETE FROM workouts WHERE id = ?;', w.id);
        }
        if (data.draft) {
          const existing = db.getFirstSync('SELECT payload FROM account_drafts WHERE account = ?;', account);
          if (existing) throw new Error('draft_exists');
          writeDraft(normalize(data.draft)); legacy.clearDraft();
        }
      });
    },
  };
}
export type AccountStore = ReturnType<typeof createAccountStore>;
