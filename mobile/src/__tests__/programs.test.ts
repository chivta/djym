import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { acceptReps, exerciseSets, loadProgramExercises, matchingProgram, normalizeName, plannedSets, previousWeights, validateProgram, weightHint } from '../programs.ts';
import { materializeDraft, newDraft, parseDraft, renameDraft, toDraft, toWorkout, validateDraft } from '../model.ts';
import type { Draft, Workout } from '../model.ts';
import { remoteWorkout, workoutBody } from '../api.ts';

const id = 'd59a15b6-8935-4c65-82e9-72228df1189f';
const draft: Draft = { id, title: ' Push  day ', date: '2026-10-18', notes: '', exercises: [] };
const program = { id, name: 'push day', entries: [{ name: 'Bench', set_count: 3, target_reps: 10 }] };
function history(date: string, weight: number, name = 'Bench'): Workout {
  return { ...draft, id: date, date, title: 'PUSH DAY', exercises: [{ id: 'e', name, sets: [{ id: 's', kg: weight, reps: 8 }] }] };
}
test('program model: domain limits, normalization and ordered targets', () => {
  assert.equal(normalizeName('  PUSH \n day '), 'push day');
  assert.equal(matchingProgram(draft, [program]), program);
  assert.equal(matchingProgram({ ...draft, title: '' }, [{ ...program, name: '' }]), undefined);
  assert.equal(validateProgram(program), false);
  for (const bad of [{ ...program, name: ' ' }, { ...program, name: 'x'.repeat(2001) }, { ...program, entries: [] },
    { ...program, entries: Array(101).fill(program.entries[0]) },
    ...[0, 101, 1.5].map(set_count => ({ ...program, entries: [{ ...program.entries[0], set_count }] })),
    ...[0, 10000, 1.1].map(target_reps => ({ ...program, entries: [{ ...program.entries[0], target_reps }] }))]) assert.equal(validateProgram(bad), true);
  assert.equal(validateProgram({ ...program, entries: [{ name: 'X', set_count: 100, target_reps: null }] }), false);
});
test('suggestions: same or earlier matching calendar days, skipping missing or unusable exercises; indexed and last-weight fallback', () => {
  const recent = history('2026-10-17', 70); recent.exercises[0].sets.push({ id: 's2', kg: 72, reps: 7 });
  const missing = history('2026-10-16', 99, 'Other');
  const empty = history('2026-10-17', 99); empty.exercises[0].sets = [];
  const all = [history(draft.date, 999), history('2026-10-19', 888), missing, history('2026-10-15', 60), recent];
  assert.deepEqual(previousWeights(draft, { name: '  BENCH ' }, all), [999]);
  assert.equal(weightHint([70,72], 8), '72'); assert.equal(weightHint([], 0), '0');
  assert.deepEqual(previousWeights(draft, { name: 'Bench' }, [missing, empty, history('2026-10-15', 60)]), [60]);
  assert.deepEqual(previousWeights(draft, { name: 'Written', canonicalName: 'Bench' }, [recent]), [70,72]);
  assert.deepEqual(previousWeights(draft, { name: 'Bench' }, [{ ...recent, id: draft.id }]), []);
  assert.deepEqual(previousWeights({ ...draft, remoteId: 9 }, { name: 'Bench' }, [{ ...recent, remoteId: 9 }]), []);
  assert.deepEqual(previousWeights({ ...draft, title: '' }, { name: 'Bench' }, all), []);
});
test('completion: targets and untouched rows remain separate; reps accepts weight, explicit weight wins, partial input errors', () => {
  const sets = plannedSets(3, () => 'set');
  const accepted: Draft = { ...draft, exercises: [{ id: 'e', name: 'Bench', suggested: true, sets }] };
  assert.deepEqual(materializeDraft(accepted).exercises, []);
  assert.deepEqual(materializeDraft({ ...accepted, remoteId: 1 }).exercises, []);
  assert.equal(validateDraft(accepted)?.code, 'exercises');
  sets[0] = acceptReps(sets[0], '8', '70');
  assert.equal(sets[0].kg, '70');
  const saved = toWorkout(accepted);
  assert.equal(saved.exercises[0].sets.length, 1);
  assert.deepEqual(saved.exercises[0].sets[0], { id: 'set', kg: 70, reps: 8 });
  assert.equal(acceptReps({ id: 's', kg: '20', reps: '' }, '9', '70').kg, '20');
  assert.equal(acceptReps({ id: 's', kg: '', reps: '' }, '', '70').kg, '');
  sets[1] = { ...sets[1], kg: '30' }; assert.equal(validateDraft(accepted)?.code, 'reps');
  sets[1] = { ...sets[1], kg: '', reps: '3' }; assert.equal(validateDraft(accepted)?.code, 'weight');
  const restored = JSON.parse(JSON.stringify(accepted)); assert.deepEqual(restored, accepted);
  assert.equal(toDraft(saved).exercises[0].sets[0].reps, '8');
});
test('free names: wire fallback and independent legacy type preserve metadata and explicit empty names', () => {
  const wire = { id: 1, performed_on: draft.date, type: 'push', raw_text: '', updated_at: '2026-10-18T00:00:00Z', source: 'telegram', source_ref: 'old', entries: [], kcal: 1000, protein_g: 60 };
  const old = remoteWorkout(wire); assert.equal(old.title, 'push'); assert.equal(old.legacyType, 'push');
  const named = remoteWorkout({ ...wire, name: 'My custom day' });
  assert.equal(named.title, 'My custom day');
  const body = workoutBody(toWorkout({ ...toDraft(named), title: 'Renamed' }));
  assert.equal(body.name, 'Renamed'); assert.equal(body.type, 'push'); assert.equal(body.kcal, 1000);
  assert.equal(remoteWorkout({ ...wire, name: '' }).title, '');
  assert.equal(workoutBody({ ...named, title: '' }).name, '');
  assert.equal(workoutBody({ ...named, legacyType: undefined, title: 'custom' }).type, '');
});

 test('planned rows: stable unique identities after row removal and correct original validation position', () => {
  const entry = { id: 'e', name: 'Bench', sets: [{ id: 'e:planned:1', kg: '30', reps: '8' }] };
  const shown = exerciseSets(entry, 3);
  assert.equal(new Set(shown.map(s => s.id)).size, 3);
  assert.deepEqual(exerciseSets(entry, 3), shown);
  shown[2] = { ...shown[2], kg: '40' };
  const actual: Draft = { ...draft, exercises: [
    { id: 'ignored', name: 'Suggestion', suggested: true, sets: plannedSets(1, () => 'a') },
    { ...entry, sets: shown },
  ] };
  assert.deepEqual(validateDraft(actual), { code: 'reps', exercise: 1, set: 2 });
 });

test('free rename retains old cached classification without assigning a new free name a type', () => {
  const old = { ...draft, title: 'push' };
  const renamed = renameDraft(old, 'New free name');
  assert.equal(renamed.legacyType, 'push'); assert.equal(renamed.title, 'New free name');
  assert.equal(renameDraft(renamed, '').legacyType, 'push');
  assert.equal(renameDraft(newDraft('new'), 'push').legacyType, '');
});


test('loadProgramExercises: explicit normalized match populates ordered blank planned exercises with unique UUIDs', () => {
  let sequence = 0;
  const uuid = () => `uuid:${++sequence}`;
  const template = { ...program, name: 'PUSH day', entries: [
    { name: ' Bench press ', set_count: 3, target_reps: 10 },
    { name: 'Push ups', set_count: 2, target_reps: null },
  ] };
  const renamed = renameDraft({ ...draft, title: 'Other' }, '  push   DAY  ');
  assert.deepEqual(renamed.exercises, []);
  const loaded = loadProgramExercises(renamed, [template], uuid);
  assert.deepEqual(loaded.exercises.map(e => e.name), [' Bench press ', 'Push ups']);
  assert.deepEqual(loaded.exercises.map(e => e.sets.length), [3, 2]);
  assert.deepEqual({ ...loaded, exercises: [] }, renamed);
  const ids = loaded.exercises.flatMap(e => [e.id, ...e.sets.map(s => s.id)]);
  assert.equal(new Set(ids).size, 7);
  assert.deepEqual(ids, Array.from({ length: 7 }, (_, i) => `uuid:${i + 1}`));
  for (const entry of loaded.exercises) {
    assert.equal(entry.suggested, true);
    for (const set of entry.sets) assert.deepEqual(set, { id: set.id, kg: '', reps: '', planned: true });
  }
  const restored = parseDraft(JSON.stringify(loaded));
  assert.deepEqual(restored, loaded);
  assert.deepEqual(materializeDraft(restored).exercises, []);
  assert.equal(validateDraft(restored)?.code, 'exercises');
  assert.deepEqual(toWorkout({ ...restored, remoteId: 1 }).exercises, []);
  assert.equal(loadProgramExercises(loaded, [template], uuid), loaded);
  assert.equal(sequence, 7);
  assert.deepEqual(renamed.exercises, []);
});

test('loadProgramExercises: preserves entered, partial and manual data and metadata while appending only missing names', () => {
  const existing: Draft = { ...draft, remoteId: 4, revision: '2026-10-18T10:00:00Z', legacyType: 'push',
    source: 'telegram', sourceRef: 'original', notes: 'Keep notes', kcal: 2400, proteinG: 160,
    startedAt: '2026-10-18T09:00:00Z', finishedAt: '2026-10-18T10:00:00Z', exercises: [
      { id: 'manual', name: 'Manual', sets: [{ id: 'manual-set', kg: '20', reps: '8' }] },
      { id: 'bench', name: '  BENCH  ', canonicalName: 'Bench', sets: [{ id: 'partial-set', kg: '60', reps: '' }] },
    ] };
  const before = structuredClone(existing);
  const template = { ...program, entries: [
    { name: 'Bench', set_count: 3, target_reps: 10 },
    { name: 'Dips', set_count: 2, target_reps: 12 },
    { name: ' dips ', set_count: 4, target_reps: null },
    { name: 'Fly', set_count: 1, target_reps: null },
  ] };
  let sequence = 0;
  const loaded = loadProgramExercises(existing, [template], () => `added:${++sequence}`);
  assert.deepEqual(existing, before);
  assert.deepEqual({ ...loaded, exercises: existing.exercises }, existing);
  assert.deepEqual(loaded.exercises.map(e => e.name), ['Manual', '  BENCH  ', 'Dips', 'Fly']);
  assert.equal(loaded.exercises[0], existing.exercises[0]);
  assert.equal(loaded.exercises[1], existing.exercises[1]);
  assert.deepEqual(parseDraft(JSON.stringify(loaded)), loaded);
  assert.deepEqual(materializeDraft(loaded).exercises, existing.exercises);
  assert.deepEqual(validateDraft(loaded), { code: 'reps', exercise: 1, set: 0 });
  assert.equal(loadProgramExercises(loaded, [template], () => { throw new Error('unexpected UUID'); }), loaded);
});

test('loadProgramExercises: missing or blank program match is a no-op without allocating UUIDs', () => {
  const uuid = () => { throw new Error('unexpected UUID'); };
  assert.equal(loadProgramExercises(draft, [], uuid), draft);
  const unmatched = { ...draft, title: 'Other' };
  assert.equal(loadProgramExercises(unmatched, [program], uuid), unmatched);
  const blank = { ...draft, title: '  ' };
  assert.equal(loadProgramExercises(blank, [{ ...program, name: '' }], uuid), blank);
});

test('previousWeights: latest same-day remote ID wins over shuffled cache order and edit revisions', () => {
  const older = { ...history(draft.date, 60), id: 'remote:20', remoteId: 20, revision: '2026-10-18T23:00:00Z' };
  const latest = { ...history(draft.date, 80), id: 'remote:30', remoteId: 30, revision: '2026-10-18T10:00:00Z' };
  latest.exercises[0].sets.push({ id: 'second', kg: 82.5, reps: 6 });
  const earlier = { ...history('2026-10-17', 40), id: 'remote:99', remoteId: 99 };
  for (const all of [[older, earlier, latest], [latest, older, earlier], [earlier, older, latest]]) {
    assert.deepEqual(previousWeights(draft, { name: 'Bench' }, all), [80, 82.5]);
  }
});


test('previousWeights: local same-day ties retain cache order when remote IDs cannot establish order', () => {
  const first = { ...history(draft.date, 55), id: 'local:first', revision: '2026-10-18T09:00:00Z' };
  const second = { ...history(draft.date, 65), id: 'local:second', revision: '2026-10-18T23:00:00Z' };
  assert.deepEqual(previousWeights(draft, { name: 'Bench' }, [first, second]), [55]);
  assert.deepEqual(previousWeights(draft, { name: 'Bench' }, [second, first]), [65]);
  const remote = { ...second, id: 'remote:100', remoteId: 100 };
  assert.deepEqual(previousWeights(draft, { name: 'Bench' }, [first, remote]), [55]);
  assert.deepEqual(previousWeights(draft, { name: 'Bench' }, [remote, first]), [65]);
});

test('previousWeights: same-day matching normalizes names and aliases, excludes self/foreign/future, and falls back past unusable sets', () => {
  const sameDay = { ...history(draft.date, 70, 'Written alias'), id: 'remote:10', remoteId: 10, title: '  PUSH   day  ' };
  sameDay.exercises[0].canonicalName = ' Bench   press ';
  sameDay.exercises[0].sets.push({ id: 'second', kg: 72.5, reps: 6 });
  const current = { ...draft, remoteId: 20 };
  const excluded = [
    { ...history(draft.date, 999, 'Bench press'), id: draft.id },
    { ...history(draft.date, 888, 'Bench press'), id: 'other-local-id', remoteId: 20 },
    { ...history(draft.date, 777, 'Bench press'), id: 'foreign', title: 'Pull day', remoteId: 100 },
    { ...history('2026-10-19', 666, 'Bench press'), id: 'future', remoteId: 101 },
  ];
  const exercise = { name: 'Custom written name', canonicalName: '  BENCH press ' };
  assert.deepEqual(previousWeights(current, exercise, excluded), []);
  assert.equal(weightHint(previousWeights(current, exercise, excluded), 0), '0');
  const weights = previousWeights(current, exercise, [...excluded, sameDay]);
  assert.deepEqual(weights, [70, 72.5]);
  assert.deepEqual([0, 1, 2].map(i => weightHint(weights, i)), ['70', '72.5', '72.5']);
  assert.deepEqual(previousWeights(current, { name: '  written   ALIAS ' }, [sameDay]), weights);
  const missing = { ...history(draft.date, 99, 'Other'), id: 'remote:40', remoteId: 40 };
  const unusable = { ...history(draft.date, 99, 'Bench press'), id: 'remote:30', remoteId: 30 };
  unusable.exercises[0].sets = [{ id: 'bad-weight', kg: -1, reps: 8 }, { id: 'no-reps', kg: 99, reps: 0 }];
  const earlier = { ...history('2026-10-17', 45, 'Bench press'), id: 'earlier', remoteId: 9 };
  assert.deepEqual(previousWeights(current, exercise, [earlier, missing, unusable, sameDay]), weights);
  assert.deepEqual(previousWeights(current, exercise, [missing, unusable, earlier]), [45]);
});

test('previousWeights: same-day grey hints stay out of untouched materialization and reps accepts them without replacing explicit kg', () => {
  let sequence = 0;
  const loaded = loadProgramExercises(draft, [program], () => `loaded:${++sequence}`);
  const before = structuredClone(loaded);
  const savedEarlierToday = { ...history(draft.date, 85), id: 'remote:50', remoteId: 50 };
  const weights = previousWeights(loaded, loaded.exercises[0], [savedEarlierToday]);
  assert.deepEqual(weights, [85]);
  assert.deepEqual(loaded, before);
  const restored = parseDraft(JSON.stringify(loaded));
  assert.deepEqual(materializeDraft(restored).exercises, []);
  const sets = restored.exercises[0].sets;
  sets[0] = acceptReps(sets[0], '8', weightHint(weights, 0));
  assert.equal(sets[0].kg, '85');
  sets[1] = acceptReps({ ...sets[1], kg: '42.5' }, '6', weightHint(weights, 1));
  assert.equal(sets[1].kg, '42.5');
  assert.deepEqual(toWorkout(restored).exercises[0].sets, [
    { id: sets[0].id, kg: 85, reps: 8 }, { id: sets[1].id, kg: 42.5, reps: 6 },
  ]);
  assert.deepEqual(loaded, before);
});
