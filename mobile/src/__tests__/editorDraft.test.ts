import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDraftChange } from '../editorDraft.ts';
import { newDraft } from '../model.ts';

test('retained editor callbacks apply edits to the latest draft, not their render snapshot', () => {
  const initial = newDraft('draft');
  initial.exercises = [{ id: 'exercise', name: 'Bench', sets: [{ id: 'set', kg: '', reps: '' }] }];
  let latest = initial;
  const editNotes = (value: string) => applyDraftChange(latest, draft => ({ ...draft, notes: value }));
  const editTitle = (value: string) => applyDraftChange(latest, draft => ({ ...draft, title: value }));

  latest = editNotes('keep this');
  latest = editTitle('Push');
  assert.equal(latest.notes, 'keep this');
  assert.equal(latest.title, 'Push');

  // A set callback retained from the prior render must preserve intervening edits.
  const retainedDraft = initial;
  latest = applyDraftChange(latest, draft => ({ ...draft, exercises: draft.exercises.map(exercise =>
    exercise.id === 'exercise' ? { ...exercise, sets: exercise.sets.map(set => set.id === 'set' ? { ...set, reps: '8' } : set) } : exercise) }));
  assert.equal(latest.notes, 'keep this');
  assert.equal(latest.exercises[0].sets[0].reps, '8');
  assert.equal(retainedDraft.notes, '');
});
