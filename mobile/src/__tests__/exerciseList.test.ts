import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existingSelection, exercisePreview, invalidExerciseId, toggleExercise } from '../exerciseList.ts';
import type { Draft, DraftSet } from '../model.ts';

function sets(values: [string, string][]): DraftSet[] {
  return values.map(([kg, reps], index) => ({ id: String(index), kg, reps }));
}
function draft(): Draft {
  return { id: 'workout', date: '2026-10-11', title: '', notes: '', exercises: [
    { id: 'a', name: 'Bench', sets: sets([['10', '5']]) },
    { id: 'b', name: 'Row', sets: sets([['20', '6']]) },
  ] };
}

test('exercise selection begins empty, toggles closed, switches, and clears on removal', () => {
  const entries = draft().exercises;
  assert.equal(existingSelection(null, entries), null);
  let selected = toggleExercise(null, 'a');
  assert.equal(selected, 'a');
  assert.equal(toggleExercise(selected, 'a'), null);
  selected = toggleExercise(selected, 'b');
  assert.equal(selected, 'b');
  assert.equal(existingSelection(selected, entries.slice(0, 1)), null);
  assert.equal(existingSelection('a', entries.slice(0, 1)), 'a');
});

test('save validation selects the actual invalid exercise, but not metadata errors', () => {
  const value = draft();
  assert.equal(invalidExerciseId(value), null);
  value.exercises[1].sets[0].reps = '';
  assert.equal(invalidExerciseId(value), 'b');
  value.date = '';
  assert.equal(invalidExerciseId(value), null);
  value.date = '2026-10-11';
  value.exercises[0].name = '';
  assert.equal(invalidExerciseId(value), 'a');
  value.exercises[0].name = 'Bench';
  value.exercises[0].sets = [];
  assert.equal(invalidExerciseId(value), 'a');
});

test('Telegram preview groups repeated weights and shows each weight change', () => {
  assert.equal(exercisePreview(sets([['10', '5'], ['10', '6'], ['10', '7']])), '10-5 -6 -7');
  assert.equal(exercisePreview(sets([['10', '5'], ['10', '6'], ['12.5', '7'], ['12.5', '8'], ['10', '9']])), '10-5 -6 12.5-7 -8 10-9');
});

test('preview normalizes comma, decimals and zero without changing draft strings', () => {
  const values = sets([[' 10,50 ', '05'], ['10.5', '6'], ['0', '7'], ['0.00', '8']]);
  const before = structuredClone(values);
  assert.equal(exercisePreview(values), '10.5-5 -6 0-7 -8');
  assert.deepEqual(values, before);
});

test('missing or invalid values remain visibly unknown and break inheritance', () => {
  assert.equal(exercisePreview(sets([['10', '5'], ['', '6'], ['10', '7'], ['10', ''], ['10', '8']])), '10-5 ?-6 10-7 10-? 10-8');
  for (const kg of ['-1', '1e2', '12.', '12.345', '10000', 'NaN', '.5']) {
    assert.equal(exercisePreview(sets([[kg, '5']])), '?-5', kg);
  }
  for (const reps of ['', '0', '-1', '1.5', '10000', 'NaN']) {
    assert.equal(exercisePreview(sets([['10', reps]])), '10-?', reps);
  }
  assert.equal(exercisePreview(sets([['', '']])), '?-?');
  assert.equal(exercisePreview([]), 'No sets');
  assert.equal(exercisePreview(sets([['10', '10000']]), true), '10-10000');
});
