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
        type Entry = { row: Row; order: number; remoteNode: IndexNode; sourceNode: IndexNode };
        type IndexNode = { key: unknown; owner: Map<unknown, IndexNode>; entry: Entry; previous?: IndexNode; next?: IndexNode };
        const byRemote = new Map<unknown, IndexNode>();
        const bySourceRef = new Map<unknown, IndexNode>();
        function link(owner: Map<unknown, IndexNode>, key: unknown, entry: Entry, slot: 'remoteNode' | 'sourceNode') {
          let next = owner.get(key);
          let previous: IndexNode | undefined;
          while (next && next.entry.order < entry.order) {
            previous = next;
            next = next.next;
          }
          const node: IndexNode = { key, owner, entry, next, previous };
          if (previous) previous.next = node;
          else owner.set(key, node);
          if (next) next.previous = node;
          entry[slot] = node;
        }
        function unlink(node: IndexNode) {
          if (node.previous) node.previous.next = node.next;
          else if (node.next) node.owner.set(node.key, node.next);
          else node.owner.delete(node.key);
          if (node.next) node.next.previous = node.previous;
        }
        function index(entry: Entry) {
          link(byRemote, entry.row.workout.remoteId, entry, 'remoteNode');
          link(bySourceRef, entry.row.workout.sourceRef, entry, 'sourceNode');
        }
        const snapshot = rows();
        const entries: Entry[] = new Array(snapshot.length);
        let nextOrder = -1;
        // rows() is rowid DESC; reverse insertion keeps each index head at the original first match.
        for (let i = snapshot.length - 1; i >= 0; i--) {
          const entry = { row: snapshot[i], order: i } as Entry;
          entries[i] = entry;
          index(entry);
        }
        function replace(entry: Entry, row: Row) {
          const remoteChanged = entry.row.workout.remoteId !== row.workout.remoteId;
          const sourceChanged = entry.row.workout.sourceRef !== row.workout.sourceRef;
          if (remoteChanged) unlink(entry.remoteNode);
          if (sourceChanged) unlink(entry.sourceNode);
          entry.row = row;
          if (remoteChanged) link(byRemote, row.workout.remoteId, entry, 'remoteNode');
          if (sourceChanged) link(bySourceRef, row.workout.sourceRef, entry, 'sourceNode');
        }
        const incomingRemoteIds = new Set(workouts.map(w => w.remoteId));
        for (const w of workouts) {
          const remote = byRemote.get(w.remoteId)?.entry;
          const source = w.source === 'mobile' ? bySourceRef.get(w.sourceRef)?.entry : undefined;
          const entry = remote && source ? (remote.order <= source.order ? remote : source) : remote ?? source;
          const r = entry?.row;
          if (r?.pending) {
            if (!r.workout.remoteId && !r.error) {
              const adopted = { ...r, workout: { ...r.workout, remoteId: w.remoteId, revision: w.revision } };
              put(adopted); replace(entry!, adopted);
            }
          } else if (r?.workout.id !== draftId) {
            const merged = { workout: { ...w, id: r?.workout.id ?? w.id }, generation: r?.generation ?? 0, pending: false, deleted: false, submitted: true, error: '' };
            put(merged);
            if (entry) replace(entry, merged);
            else {
              const added = { row: merged, order: nextOrder-- } as Entry;
              entries.push(added); index(added);
            }
          }
        }
        // A successful full snapshot can remove remote deletions, never local pending writes.
        for (const entry of entries) {
          const r = entry.row;
          if (!r.pending && r.workout.id !== draftId && r.workout.remoteId && !incomingRemoteIds.has(r.workout.remoteId)) erase(r.workout.id);
        }
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
          return { ...d, id, legacyType: title };
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
