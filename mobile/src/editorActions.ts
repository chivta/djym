import type { Draft, DraftExercise, DraftSet } from './model.ts';
import { exerciseSets, plannedSets } from './programs.ts';

export function updateDraftSet(draft: Draft, exerciseId: string, setId: string, update: (set: DraftSet) => DraftSet, plannedCount: number | ((exercise: DraftExercise) => number) = 0): Draft {
  return { ...draft, exercises: draft.exercises.map(exercise => exercise.id === exerciseId ? {
    ...exercise,
    sets: exerciseSets(exercise, typeof plannedCount === 'number' ? plannedCount : plannedCount(exercise)).map(set => set.id === setId ? update(set) : set),
  } : exercise) };
}

export function addDraftSet(draft: Draft, exerciseId: string, plannedCount: number | ((exercise: DraftExercise) => number), uuid: () => string): Draft {
  return { ...draft, exercises: draft.exercises.map(exercise => exercise.id === exerciseId ? {
    ...exercise, sets: [...exerciseSets(exercise, typeof plannedCount === 'number' ? plannedCount : plannedCount(exercise)), ...plannedSets(1, uuid)],
  } : exercise) };
}

export function removeDraftSet(draft: Draft, exerciseId: string, setId: string, plannedCount: number | ((exercise: DraftExercise) => number)): Draft {
  return { ...draft, exercises: draft.exercises.map(exercise => exercise.id === exerciseId ? {
    ...exercise, sets: exerciseSets(exercise, typeof plannedCount === 'number' ? plannedCount : plannedCount(exercise)).filter(set => set.id !== setId),
  } : exercise) };
}
