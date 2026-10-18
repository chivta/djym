import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { acceptReps, exerciseSets, matchingProgram, normalizeName, plannedSets, previousWeights, validateProgram, weightHint } from '../programs.ts';
import { materializeDraft, newDraft, renameDraft, toDraft, toWorkout, validateDraft } from '../model.ts';
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
test('suggestions: earlier matching calendar days only, skipping missing or unusable exercises; indexed and last-weight fallback', () => {
  const recent = history('2026-10-17', 70); recent.exercises[0].sets.push({ id: 's2', kg: 72, reps: 7 });
  const missing = history('2026-10-16', 99, 'Other');
  const empty = history('2026-10-17', 99); empty.exercises[0].sets = [];
  const all = [history(draft.date, 999), history('2026-10-19', 888), missing, history('2026-10-15', 60), recent];
  assert.deepEqual(previousWeights(draft, { name: '  BENCH ' }, all), [70,72]);
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
