import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDate, newDraft, parseDraft, parseWorkout, setCount, toDraft, today, toWorkout, validateDraft } from '../model.ts';
import type { Draft } from '../model.ts';
import { createStore } from '../storage.ts';

function fixture(id = 'workout-1'): Draft {
  return {
    id, date: '2026-10-11', title: ' Upper ', notes: ' Good session ',
    exercises: [{ id: 'exercise-1', name: ' Bench press ', sets: [{ id: 'set-1', kg: '60.25', reps: '10' }] }],
  };
}
function adapter(db: DatabaseSync) {
  return {
    execSync(sql: string) { db.exec(sql); },
    runSync(sql: string, ...params: (string | number)[]) { db.prepare(sql).run(...params); },
    getFirstSync<T>(sql: string, ...params: (string | number)[]): T | null { return (db.prepare(sql).get(...params) as T | undefined) ?? null; },
    getAllSync<T>(sql: string): T[] { return db.prepare(sql).all() as T[]; },
    withTransactionSync(action: () => void) {
      db.exec('BEGIN;');
      try { action(); db.exec('COMMIT;'); }
      catch (error) { db.exec('ROLLBACK;'); throw error; }
    },
  };
}

test('dates are calendar dates, including leap years', () => {
  for (const value of ['2026-10-11', '2024-02-29', '2026-12-31']) assert.equal(isDate(value), true);
  for (const value of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', '', 'garbage']) assert.equal(isDate(value), false);
  assert.equal(today(new Date(2026, 0, 2, 23, 59)), '2026-01-02');
});

test('a new draft uses a stable supplied ID and needs exercises before saving', () => {
  const draft = newDraft('stable');
  assert.equal(draft.id, 'stable');
  assert.deepEqual(validateDraft(draft), { code: 'exercises' });
});

test('validation points at the exercise and set requiring a fix', () => {
  const draft = fixture();
  draft.exercises[0].name = ' ';
  assert.deepEqual(validateDraft(draft), { code: 'name', exercise: 0 });
  draft.exercises[0].name = 'Bench';
  draft.exercises[0].sets = [];
  assert.deepEqual(validateDraft(draft), { code: 'sets', exercise: 0 });
  draft.date = '2026-02-30';
  assert.deepEqual(validateDraft(draft), { code: 'date' });
});

test('weights accept zero, decimal point or comma, but reject negatives and excessive precision', () => {
  const draft = fixture();
  for (const kg of ['0', '0.00', '60,25', '9999.99', ' 12.5 ']) {
    draft.exercises[0].sets[0].kg = kg;
    assert.equal(validateDraft(draft), null, kg);
  }
  for (const kg of ['', '-1', '1e2', 'Infinity', 'NaN', '60.125', '10000', '.5', '12.']) {
    draft.exercises[0].sets[0].kg = kg;
    assert.deepEqual(validateDraft(draft), { code: 'weight', exercise: 0, set: 0 }, kg);
  }
});

test('reps must be positive bounded integers', () => {
  const draft = fixture();
  for (const reps of ['1', '9999', ' 12 ']) {
    draft.exercises[0].sets[0].reps = reps;
    assert.equal(validateDraft(draft), null, reps);
  }
  for (const reps of ['', '0', '-1', '1.5', '1e2', 'Infinity', '10000']) {
    draft.exercises[0].sets[0].reps = reps;
    assert.deepEqual(validateDraft(draft), { code: 'reps', exercise: 0, set: 0 }, reps);
  }
});

test('saving normalizes numbers/text and editing preserves IDs, set values and ordering', () => {
  const draft = fixture();
  draft.exercises[0].sets.push({ id: 'set-2', kg: '50,5', reps: '08' });
  draft.exercises.push({ id: 'exercise-2', name: 'Pull-ups', sets: [{ id: 'set-3', kg: '0', reps: '5' }] });
  const workout = toWorkout(draft);
  assert.equal(workout.title, 'Upper');
  assert.equal(workout.notes, 'Good session');
  assert.equal(workout.exercises[0].name, 'Bench press');
  assert.deepEqual(workout.exercises[0].sets[1], { id: 'set-2', kg: 50.5, reps: 8 });
  assert.equal(setCount(workout), 3);
  assert.deepEqual(toWorkout(toDraft(workout)), workout);
  assert.equal(draft.exercises[0].name, ' Bench press ');
});

test('stored data rejects malformed or invalid records without hiding the error', () => {
  for (const json of ['{broken', 'null', '{}', '{"id":"1","exercises":[]}']) {
    assert.throws(() => parseDraft(json), /invalid_storage/);
    assert.throws(() => parseWorkout(json), /invalid_storage/);
  }
  const invalid = toWorkout(fixture());
  invalid.exercises[0].sets[0].reps = 0;
  assert.throws(() => parseWorkout(JSON.stringify(invalid)), /invalid_storage/);
  const incomplete = newDraft('unfinished');
  incomplete.date = 'not a date yet';
  assert.deepEqual(parseDraft(JSON.stringify(incomplete)), incomplete);
});

test('SQLite draft and workouts survive closing and reopening the database', context => {
  const directory = mkdtempSync(join(tmpdir(), 'djym-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'log.db');
  let db = new DatabaseSync(file);
  let store = createStore(adapter(db));
  store.save(fixture());
  const draft = newDraft('unfinished');
  draft.title = 'Partial';
  store.writeDraft(draft);
  db.close();
  db = new DatabaseSync(file);
  context.after(() => db.close());
  store = createStore(adapter(db));
  assert.deepEqual(store.load(), { workouts: [toWorkout(fixture())], draft });
});

test('SQLite saves atomically clear drafts, update stable IDs, and allow same-day sessions', context => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const store = createStore(adapter(db));
  store.writeDraft(fixture());
  store.save(fixture());
  assert.equal(store.load().draft, null);
  const updated = fixture();
  updated.title = 'Changed';
  store.save(updated);
  assert.equal(store.load().workouts.length, 1);
  assert.equal(store.load().workouts[0].title, 'Changed');
  store.save(fixture('workout-2'));
  assert.equal(store.load().workouts.length, 2);
  assert.equal(store.load().workouts[0].id, 'workout-2');
});

test('failed save rolls back the workout update and preserves its draft', context => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const store = createStore(adapter(db));
  store.save(fixture());
  const changed = fixture();
  changed.title = 'Changed';
  store.writeDraft(changed);
  db.exec("CREATE TRIGGER fail_draft_delete BEFORE DELETE ON draft BEGIN SELECT RAISE(ABORT, 'disk_failure'); END;");
  assert.throws(() => store.save(changed), /disk_failure/);
  assert.deepEqual(store.load(), { workouts: [toWorkout(fixture())], draft: changed });
});

test('rapid draft replacements preserve the final edit, and write failures preserve stored data', context => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const store = createStore(adapter(db));
  for (const title of ['P', 'Pu', 'Push']) store.writeDraft({ ...fixture(), title });
  assert.equal(store.load().draft?.title, 'Push');
  db.exec('PRAGMA query_only = ON;');
  assert.throws(() => store.writeDraft(fixture()));
  assert.equal(store.load().draft?.title, 'Push');
});

test('discarding an edit leaves the saved workout intact', context => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const store = createStore(adapter(db));
  store.save(fixture());
  store.writeDraft({ ...fixture(), title: 'Unsaved changes' });
  store.clearDraft();
  assert.deepEqual(store.load(), { workouts: [toWorkout(fixture())], draft: null });
});

test('deletion removes workout and editing draft atomically', context => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const store = createStore(adapter(db));
  store.save(fixture());
  store.writeDraft(fixture());
  db.exec("CREATE TRIGGER fail_draft_delete BEFORE DELETE ON draft BEGIN SELECT RAISE(ABORT, 'disk_failure'); END;");
  assert.throws(() => store.remove('workout-1'), /disk_failure/);
  assert.equal(store.load().workouts.length, 1);
  assert.notEqual(store.load().draft, null);
  db.exec('DROP TRIGGER fail_draft_delete;');
  store.remove('workout-1');
  assert.deepEqual(store.load(), { workouts: [], draft: null });
});

test('history sorts by calendar date descending', context => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const store = createStore(adapter(db));
  store.save({ ...fixture('newer'), date: '2026-10-11' });
  store.save({ ...fixture('older'), date: '2026-01-01' });
  assert.deepEqual(store.load().workouts.map(value => value.id), ['newer', 'older']);
});

test('unsupported schemas and corrupt JSON do not reset the database', context => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const store = createStore(adapter(db));
  db.prepare('INSERT INTO workouts (id, date, payload) VALUES (?, ?, ?)').run('broken', '2026-10-11', '{broken');
  assert.throws(() => store.load(), /invalid_storage/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workouts').get()?.count, 1);
  db.exec('PRAGMA user_version = 4;');
  assert.throws(() => createStore(adapter(db)), /unsupported_schema/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workouts').get()?.count, 1);
});
