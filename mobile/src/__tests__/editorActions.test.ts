import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDraftSet, removeDraftSet, updateDraftSet } from '../editorActions.ts';
import { createHistoryHintSelector } from '../editorHistory.ts';
import { loadProgramSnapshot } from '../editorPrograms.ts';
import { newDraft } from '../model.ts';
import { acceptReps } from '../programs.ts';
import type { Draft, Workout } from '../model.ts';

function fixture(): Draft {
  const draft = newDraft('draft');
  draft.title = 'Push';
  draft.exercises = [
    { id: 'e1', name: 'Bench', sets: [{ id: 's1', kg: '', reps: '', planned: true }, { id: 's2', kg: '70', reps: '8' }] },
    { id: 'e2', name: 'Row', sets: [{ id: 's3', kg: '40', reps: '10' }] },
  ];
  return draft;
}

test('production set callbacks preserve weight before reps and apply reps to the latest set', () => {
  let current = fixture();
  const oldCallback = (value: string) => updateDraftSet(current, 'e1', 's1', set => ({ ...set, kg: value }));
  current = oldCallback('90');
  const renderedSet = fixture().exercises[0].sets[0];
  const retainedRepsCallback = (value: string) => updateDraftSet(current, 'e1', 's1', set => acceptReps(set, value, '70'));
  // The captured view was blank and suggested 70; production callback must use current set.kg=90.
  assert.equal(renderedSet.kg, '');
  current = retainedRepsCallback('8');
  assert.deepEqual(current.exercises[0].sets[0], { id: 's1', kg: '90', reps: '8', planned: true });
});

test('retained add/remove set callbacks derive arrays from latest draft and preserve other exercises', () => {
  let current = fixture();
  const add = () => addDraftSet(current, 'e1', 3, () => 'new');
  const removeOldVisibleSet = () => removeDraftSet(current, 'e1', 's2', 3);
  current = updateDraftSet(current, 'e1', 's1', set => ({ ...set, kg: '55', reps: 'partial' }), 3);
  current = add();
  assert.deepEqual(current.exercises[0].sets.map(set => set.id), ['s1', 's2', 'e1:planned:2', 'new']);
  assert.deepEqual(current.exercises[0].sets[0], { id: 's1', kg: '55', reps: 'partial', planned: true });
  current = removeOldVisibleSet();
  assert.deepEqual(current.exercises[0].sets.map(set => set.id), ['s1', 'e1:planned:2', 'new']);
  assert.deepEqual(current.exercises[1], fixture().exercises[1]);
  current = addDraftSet(current, 'e1', 3, () => 'newer');
  current = removeDraftSet(current, 'e1', 'new', 3);
  assert.ok(current.exercises[0].sets.some(set => set.id === 'newer'));
  assert.ok(!current.exercises[0].sets.some(set => set.id === 'new'));
});

test('selected history hints reuse unchanged semantic inputs and invalidate changed inputs', () => {
  const draft = fixture();
  const history: Workout[] = [];
  let calculations = 0;
  let programLoads = 0;
  let programRows = [] as { id: string; name: string; entries: { name: string; set_count: number; target_reps: number | null }[] }[];
  const store = { load() { programLoads++; return programRows; } };
  const initialProgramSnapshot = loadProgramSnapshot(store);
  const selector = createHistoryHintSelector(() => {
    calculations++;
    return [];
  });
  const exercise = draft.exercises[0];
  selector(draft, exercise, history, exercise.id);
  selector({ ...draft, notes: 'typing' }, exercise, history, exercise.id);
  for (let i = 0; i < 100; i++) selector({ ...draft, notes: `typing-${i}` }, exercise, history, exercise.id);
  assert.equal(calculations, 1);
  assert.equal(programLoads, 1);
  assert.equal(loadProgramSnapshot(null).length, 0);
  assert.deepEqual(initialProgramSnapshot, []);
  selector({ ...draft, ...{ date: '2026-10-12' } }, exercise, history, exercise.id);
  selector(draft, { ...exercise, name: 'Incline bench' }, history, exercise.id);
  selector(draft, exercise, [...history], exercise.id);
  selector(draft, exercise, history, 'e2');
  assert.equal(calculations, 5);
  programRows = [{ id: 'p2', name: 'Push', entries: [{ name: 'Bench', set_count: 4, target_reps: 8 }] }];
  assert.equal(loadProgramSnapshot(store)[0].id, 'p2');
  assert.equal(programLoads, 2);
  const otherAccountStore = { load() { programLoads++; return []; } };
  assert.deepEqual(loadProgramSnapshot(otherAccountStore), []);
  assert.equal(programLoads, 3);
});
