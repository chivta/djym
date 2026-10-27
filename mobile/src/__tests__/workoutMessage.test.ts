import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newDraft, parseDraft, parseWorkout, toDraft, toWorkout } from '../model.ts';
import { applyWorkoutMessage, formatWorkoutMessage, parseWorkoutMessage } from '../workoutMessage.ts';
import { appendProgramTemplate, buildHistorySuggestionIndex } from '../messageSuggestions.ts';
import { createStore } from '../storage.ts';
import { accountKey, createAccountStore } from '../accountStore.ts';
import type { Database } from '../storage.ts';
import type { Draft, Workout } from '../model.ts';

const now = new Date('2026-10-03T20:00:00Z');
const base = { ...newDraft('draft-id'), date: '2026-10-03', title: 'Custom day', notes: 'keep this', legacyType: 'push', kcal: 900, proteinG: 40, remoteId: 12, revision: '2026-10-03T10:00:00Z', source: 'telegram', sourceRef: 'ref', startedAt: '2026-10-03T09:00:00Z', finishedAt: null };
function ok(text: string, draft = base) { const result = parseWorkoutMessage(text, draft, now); assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error('parse failed'); return result.draft; }

test('message grammar follows Telegram fixtures: inherited and decimal weights, unicode names, blank CRLF lines, plans', () => {
  const d = ok('\r\n03.10 upper (680/37)\r\n\r\nжим в нахилі сміт 60-10 -9 50-11 -10\r\nпідтягування 82-9 -9\r\nскручування -10 -20 -30\r\nрозведення 13.5-8 13.5-');
  assert.equal(d.title, 'upper'); assert.equal(d.kcal, 680); assert.equal(d.proteinG, 37);
  assert.deepEqual(d.exercises[0].sets.map(s => [s.kg, s.reps]), [['60','10'],['60','9'],['50','11'],['50','10']]);
  assert.deepEqual(d.exercises[1].sets.map(s => s.kg), ['82','82']); assert.deepEqual(d.exercises[2].sets.map(s => s.kg), ['0','0','0']);
  assert.equal(d.exercises[3].sets[1].planned, true); assert.equal(d.exercises[3].sets[1].kg, '13.5');
});

test('message header supports default date, explicit year/leap date, free names and additive notes/intake', () => {
  const noHeader = ok('жим гантелей 30-10'); assert.equal(noHeader.date, '2026-10-03'); assert.equal(noHeader.title, base.title);
  assert.equal(ok('Free name | fresh note').title, 'Free name');
  assert.equal(ok('29.02.2024 Workout with a free name | sore back (ignored)\nжим 60-8').date, '2024-02-29');
  const d = ok('05.01.2025 My free workout (1200/90) | took notes\nPress 50-8');
  assert.equal(d.title, 'My free workout'); assert.equal(d.notes, 'keep this\ntook notes'); assert.equal(d.kcal, 1200); assert.equal(d.proteinG, 90);
  for (const text of ['29.02.2025\nPress 40-8', '32.10\nPress 40-8']) { const r = parseWorkoutMessage(text, base, now); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.issue.code, 'bad_date'); }
});

test('errors are line-specific and preserve incomplete/invalid input as draft metadata only', () => {
  for (const [text, code, line] of [['03.10\nPress', 'no_sets', 2], ['03.10\n60-10', 'no_name', 2], ['03.10\nPress 60-10 bad -8', 'bad_token', 2], ['03.10\nPress 60-0', 'zero_reps', 2]] as const) {
    const result = parseWorkoutMessage(text, base, now); assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.issue.code, code); assert.equal(result.issue.line, line); }
  }
  const partial = ok('03.10\nPress 60-'); assert.equal(partial.messageText, '03.10\nPress 60-'); assert.equal(partial.exercises[0].sets[0].reps, '');
  assert.throws(() => toWorkout(partial));
});

test('editing preserves IDs/order by aliases and metadata; output identifies nonrepresentable structured fields', () => {
  const existing: Draft = { ...base, exercises: [
    { id: 'press-id', name: 'Press', canonicalName: 'Bench press', sets: [{ id: 'set-1', kg: '40', reps: '8' }, { id: 'set-2', kg: '35', reps: '7' }] },
    { id: 'row-id', name: 'Row', sets: [] },
  ] };
  const changed = applyWorkoutMessage('03.10 Push\nBench press 50-8\nRow 20-9', existing, now);
  assert.equal(changed.ok, true); if (!changed.ok) return;
  assert.deepEqual(changed.draft.exercises.map(e => e.id), ['press-id', 'row-id']);
  assert.deepEqual(changed.draft.exercises[0].sets.map(s => s.id), ['set-1']);
  assert.equal(changed.draft.remoteId, 12); assert.equal(changed.draft.notes, existing.notes); assert.equal(changed.draft.legacyType, 'push');
  const formatted = formatWorkoutMessage(existing); assert.match(formatted.text, /\| keep this/); assert.equal(formatted.lossless, false);
  assert.ok(formatted.reasons.some(reason => reason.includes('metadata')));
});

test('stored drafts accept old JSON and validated messageText, saved/wire workout strips composer data', () => {
  const old = { ...newDraft('old'), exercises: [] }; assert.deepEqual(parseDraft(JSON.stringify(old)), old);
  const draft = { ...newDraft('new'), messageText: 'invalid raw\n' }; assert.equal(parseDraft(JSON.stringify(draft)).messageText, 'invalid raw\n');
  assert.throws(() => parseDraft(JSON.stringify({ ...draft, messageText: 12 })), /invalid_storage/);
  const valid = { ...base, exercises: [{ id: 'e', name: 'Press', sets: [{ id: 's', kg: '30', reps: '8' }] }], messageText: 'raw' };
  const saved = toWorkout(valid); assert.equal('messageText' in saved, false); assert.equal('messageText' in toDraft(saved), false);
  assert.throws(() => parseWorkout(JSON.stringify({ ...saved, messageText: 'leaked' })), /invalid_storage/);
  assert.equal(parseWorkout(JSON.stringify(saved)).id, base.id);
});

test('SQLite and account stores persist raw draft over reopen and save clean workout data', (context: TestContext) => {
  const directory = mkdtempSync(join(tmpdir(), 'djym-message-')); context.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'messages.db'); let db = new DatabaseSync(filename);
  const adapter = (): Database => ({
    execSync(sql: string) { db.exec(sql); },
    runSync(sql: string, ...params: (string | number)[]) { db.prepare(sql).run(...params); },
    getFirstSync<T>(sql: string, ...params: (string | number)[]): T | null { return (db.prepare(sql).get(...params) as T | undefined) ?? null; },
    getAllSync<T>(sql: string, ...params: (string | number)[]): T[] { return db.prepare(sql).all(...params) as T[]; },
    withTransactionSync(action) { db.exec('BEGIN;'); try { action(); db.exec('COMMIT;'); } catch (error) { db.exec('ROLLBACK;'); throw error; } },
  });
  const draft = { ...newDraft('persist'), messageText: 'partial text' };
  let legacy = createStore(adapter());
  const saveable = { ...newDraft('saved'), exercises: [{ id: 'e', name: 'Press', sets: [{ id: 's', kg: '60', reps: '8' }] }], messageText: 'not persisted in workout' };
  const saved = legacy.save(saveable); assert.equal('messageText' in saved, false); legacy.writeDraft(draft);
  const session = { apiURL: 'https://api.invalid', userId: 1 };
  const account = createAccountStore(adapter(), accountKey(session)); account.writeDraft(draft);
  db.close(); db = new DatabaseSync(filename);
  legacy = createStore(adapter()); assert.equal(legacy.load().draft?.messageText, 'partial text');
  assert.equal('messageText' in parseWorkout(JSON.stringify(legacy.load().workouts[0])), false);
  const reopenedAccount = createAccountStore(adapter(), accountKey(session)); assert.equal(reopenedAccount.load().draft?.messageText, 'partial text');
  assert.throws(() => parseDraft(JSON.stringify({ ...draft, messageText: 3 })), /invalid_storage/);
  context.after(() => db.close());
});

test('cached history suggestions preserve aliases, latest same-day history, exclusions, and recent fallback', () => {
  const workout = (id: string, date: string, remoteId: number | undefined, name: string, kg: number): Workout => ({ ...toWorkout({ ...newDraft(id), date, title: 'Push', exercises: [{ id: 'e', name, sets: [{ id: 's', kg: String(kg), reps: '8' }] }] }), ...(remoteId ? { remoteId } : {}) });
  const hist = [workout('earlier', '2026-10-02', 99, 'Bench', 40), workout('remote-low', '2026-10-03', 10, 'Bench', 60), workout('remote-high', '2026-10-03', 20, 'Bench', 70), workout('future', '2026-10-04', 30, 'Bench', 80), workout('other', '2026-10-03', 40, 'Row', 50)];
  const current = { ...base, title: 'Push', date: '2026-10-03', exercises: [] };
  const index = buildHistorySuggestionIndex(current, hist);
  assert.deepEqual(index.weightsFor({ name: 'BENCH press', canonicalName: 'Bench' }), [70]);
  assert.deepEqual(index.weightsFor({ name: 'Row' }), [50]); assert.equal(index.scannedWorkouts, 5); assert.equal(index.sortedWorkouts, 4);
  assert.ok(index.historyRecordsRead < index.scannedWorkouts, 'indexed current-line lookup reads fewer records than scanning full history');
  assert.deepEqual(buildHistorySuggestionIndex({ ...current, title: '' }, hist).weightsFor({ name: 'Bench' }), []);
  assert.ok(buildHistorySuggestionIndex({ ...current, title: '' }, hist).recentExercises().length > 0);
  const template = { id: 'p', name: 'Push', entries: [{ name: 'Bench', set_count: 2, target_reps: 8 }, { name: 'Row', set_count: 2, target_reps: null }] };
  let i = 0; const appended = appendProgramTemplate({ ...current, exercises: [{ id: 'manual', name: 'Bench', sets: [{ id: 'partial', kg: '55', reps: '' }] }] }, [template], () => `u${++i}`);
  assert.equal(appended.exercises[0].sets[0].reps, ''); assert.equal(appended.exercises[0].id, 'manual'); assert.equal(appended.exercises[1].suggested, true);
});
