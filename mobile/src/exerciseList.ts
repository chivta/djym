import { MAX_REPS, MAX_WEIGHT, validateDraft } from './model.ts';
import type { Draft, DraftExercise, DraftSet } from './model.ts';
import { t } from './i18n.ts';

export function toggleExercise(selectedId: string | null, id: string): string | null {
  return selectedId === id ? null : id;
}

export function existingSelection(selectedId: string | null, exercises: readonly DraftExercise[]): string | null {
  return exercises.some(entry => entry.id === selectedId) ? selectedId : null;
}

export function invalidExerciseId(draft: Draft): string | null {
  const issue = validateDraft(draft);
  return issue?.exercise === undefined ? null : draft.exercises[issue.exercise].id;
}

// An incomplete set breaks inheritance: the next complete set must show its weight.
export function exercisePreview(sets: readonly DraftSet[], historical = false): string {
  if (!sets.length) return t.noSets;
  let previousWeight: number | null = null;
  return sets.map(set => {
    const kg = set.kg.trim();
    const reps = set.reps.trim();
    const weight = /^\d+(?:[.,]\d{1,2})?$/.test(kg) && Number(kg.replace(',', '.')) <= MAX_WEIGHT
      ? Number(kg.replace(',', '.')) : null;
    const count = /^\d+$/.test(reps) && Number.isSafeInteger(Number(reps)) && Number(reps) >= 1 && (historical || Number(reps) <= MAX_REPS)
      ? Number(reps) : null;
    const token = t.setPreview(weight === null ? null : weight === previousWeight && count !== null ? '' : String(weight), count === null ? null : String(count));
    previousWeight = weight !== null && count !== null ? weight : null;
    return token;
  }).join(t.setPreviewSeparator);
}
