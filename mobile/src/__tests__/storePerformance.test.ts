import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { accountKey, createAccountStore } from '../accountStore.ts';
import type { Database } from '../storage.ts';
import { toWorkout, type Draft, type Workout } from '../model.ts';
import type { Session } from '../api.ts';

const session: Session = { apiURL: 'https://store.test/api', userId: 77, token: 'not-stored', expiresAt: '2099-01-01T00:00:00Z' };
const revision = '2026-10-11T12:00:00.000Z';
function draft(id: string): Draft {
  return { id, date: '2026-10-11', title: 'upper', notes: `local-${id}`, exercises: [{ id: `exercise-${id}`, name: 'Bench', sets: [{ id: `set-${id}`, kg: '60', reps: '8' }] }] };
}
function workout(id: string, remoteId: number, notes = `server-${id}`, source = 'telegram', sourceRef = `ref-${id}`): Workout {
  return { ...toWorkout(draft(id)), id, remoteId, revision, source, sourceRef, notes };
}
function representativeWorkout(id: string, remoteId: number, notes = `server-${id}`): Workout {
  const wide = draft(id);
  wide.exercises = Array.from({ length: 6 }, (_, exercise) => ({
    id: `exercise-${id}-${exercise}`, name: `Exercise ${exercise}`,
    sets: Array.from({ length: 3 }, (_, set) => ({ id: `set-${id}-${exercise}-${set}`, kg: String(40 + set), reps: String(8 + set) })),
  }));
  return { ...toWorkout(wide), id, remoteId, revision, source: 'telegram', sourceRef: `ref-${id}`, notes };
}
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  let fullRowsReads = 0;
  const db: Database = {
    execSync(sql) { sqlite.exec(sql); },
    runSync(sql, ...params) { sqlite.prepare(sql).run(...params); },
    getFirstSync<T>(sql: string, ...params: (string | number)[]): T | null { return (sqlite.prepare(sql).get(...params) as T | undefined) ?? null; },
    getAllSync<T>(sql: string, ...params: (string | number)[]): T[] {
      if (sql.indexOf('SELECT * FROM account_workouts') === 0) fullRowsReads++;
      return sqlite.prepare(sql).all(...params) as T[];
    },
    withTransactionSync(action) { sqlite.exec('BEGIN'); try { action(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  const store = createAccountStore(db, accountKey(session));
  return { sqlite, db, store, fullRowsReads: () => fullRowsReads };
}
function directInsert(sqlite: DatabaseSync, account: string, row: Workout, options: { generation?: number; pending?: number; deleted?: number; submitted?: number; error?: string } = {}) {
  sqlite.prepare(`INSERT INTO account_workouts (account,id,payload,generation,pending,deleted,submitted,error) VALUES (?,?,?,?,?,?,?,?)`).run(
    account, row.id, JSON.stringify(row), options.generation ?? 0, options.pending ?? 0, options.deleted ?? 0, options.submitted ?? 1, options.error ?? '',
  );
}

test('merge reads/parses its account snapshot once for 500 cached workouts and preserves identity/deletion', () => {
  const { sqlite, db, store, fullRowsReads } = setup();
  try {
    const account = accountKey(session);
    for (let i = 0; i < 500; i++) directInsert(sqlite, account, representativeWorkout(`local-${i}`, i + 1));
    const history = Array.from({ length: 500 }, (_, i) => representativeWorkout(`remote-${i}`, i + 1, `updated-${i}`));
    const before = Date.now();
    store.merge(history);
    const elapsed = Date.now() - before;
    assert.equal(fullRowsReads(), 1, 'one full account_workouts read regardless of history size');
    const rows = store.rows();
    assert.equal(rows.length, 500);
    assert.equal(rows[0].workout.id, 'local-499');
    assert.equal(rows.find(r => r.workout.remoteId === 1)?.workout.id, 'local-0');
    assert.equal(rows.find(r => r.workout.remoteId === 500)?.workout.notes, 'updated-499');
    // Retain honest host-only measurement as output for comparison with the parent's baseline.
    console.log(`STORE_MERGE_BENCH rows=500 incoming=500 fullRowsReads=${fullRowsReads() - 1} elapsedMs=${elapsed}`);
  } finally { sqlite.close(); }
});

test('merge retains pending generations, conflicts, active drafts, tombstones, and mobile source-ref adoption', () => {
  const { sqlite, store } = setup();
  try {
    const initial = workout('remote-local', 40);
    store.merge([initial]);
    const local = store.rows()[0];
    store.save({ ...draft(local.workout.id), notes: 'new local edit' });
    const changed = store.rows()[0];
    assert.equal(changed.generation, 1);
    store.failure(changed, 'conflict');
    store.writeDraft({ ...draft(local.workout.id), notes: 'unfinished active draft' });
    store.merge([{ ...workout('incoming-copy', 40, 'server changed'), revision: '2026-10-12T00:00:00Z' }]);
    let current = store.rows().find(r => r.workout.id === local.workout.id)!;
    assert.equal(current.pending, true); assert.equal(current.generation, 1); assert.equal(current.error, 'conflict');
    assert.equal(current.workout.notes, 'new local edit');
    assert.equal(store.load().draft?.notes, 'unfinished active draft');

    store.merge([workout('draft-base', 44, 'saved server copy')]);
    const draftBase = store.rows().find(r => r.workout.remoteId === 44)!;
    store.writeDraft({ ...draft(draftBase.workout.id), notes: 'actively editing' });
    store.merge([workout('draft-base-wire', 44, 'new history copy')]);
    assert.equal(store.rows().find(r => r.workout.remoteId === 44)?.workout.notes, 'saved server copy');
    assert.equal(store.load().draft?.notes, 'actively editing');

    const unknown = draft('uncertain-create');
    store.save(unknown);
    const pending = store.rows().find(r => r.workout.id === unknown.id)!;
    store.submitted(unknown.id);
    store.merge([workout('wire-copy', 41, 'server ack', 'mobile', unknown.id)]);
    current = store.rows().find(r => r.workout.id === unknown.id)!;
    assert.equal(current.workout.remoteId, 41); assert.equal(current.pending, true); assert.equal(current.submitted, true);
    assert.equal(current.generation, pending.generation); assert.equal(current.deleted, false);

    const tombstone = draft('pending-delete'); store.save(tombstone); store.submitted(tombstone.id); store.remove(tombstone.id);
    store.merge([workout('tombstone-wire', 42, 'must not replace', 'mobile', tombstone.id)]);
    current = store.rows().find(r => r.workout.id === tombstone.id)!;
    assert.equal(current.deleted, true); assert.equal(current.pending, true); assert.equal(current.workout.remoteId, 42);
    assert.equal(store.load().workouts.some(w => w.id === tombstone.id), false);

    const blocked = draft('sticky-create'); store.save(blocked); store.failure(store.rows().find(r => r.workout.id === blocked.id)!, 'conflict');
    store.merge([workout('blocked-wire', 43, 'should not adopt', 'mobile', blocked.id)]);
    current = store.rows().find(r => r.workout.id === blocked.id)!;
    assert.equal(current.workout.remoteId, undefined); assert.equal(current.error, 'conflict');
    assert.equal(store.rows().length > 0, true);
  } finally { sqlite.close(); }
});

test('merge uses newest row identity and applies repeated incoming records in order without crossing accounts', () => {
  const { sqlite, db, store } = setup();
  try {
    const account = accountKey(session);
    const older = workout('older-local', 70, 'older', 'telegram', 'older-ref');
    const newer = workout('newer-local', 70, 'newer', 'telegram', 'newer-ref');
    directInsert(sqlite, account, older);
    directInsert(sqlite, account, newer);
    directInsert(sqlite, account, workout('deleted-local', 71, 'deleted'));
    const foreign = createAccountStore(db, accountKey({ ...session, userId: 78 }));
    foreign.save(draft('foreign-only'));
    store.merge([
      workout('ignored-incoming', 70, 'first pass', 'telegram', 'newer-ref'),
      workout('ignored-incoming', 70, 'last pass', 'telegram', 'newer-ref'),
    ]);
    const rows = store.rows();
    assert.equal(rows.length, 2);
    assert.equal(rows.some(r => r.workout.id === 'deleted-local'), false, 'complete history removes absent remote rows');
    assert.equal(rows.find(r => r.workout.id === 'newer-local')?.workout.notes, 'last pass');
    assert.equal(rows.find(r => r.workout.id === 'older-local')?.workout.notes, 'older');
    assert.deepEqual(foreign.load().workouts.map(w => w.id), ['foreign-only']);
  } finally { sqlite.close(); }
});
