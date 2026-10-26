import type { Draft, DraftExercise, Workout } from './model.ts';
import { previousWeights } from './programs.ts';

export function createHistoryHintSelector(calculate = previousWeights) {
  let key: readonly unknown[] | null = null;
  let weights: number[] = [];
  return (draft: Draft, exercise: Pick<DraftExercise, 'id' | 'name' | 'canonicalName'>, history: Workout[], selection: string | null): number[] => {
    const nextKey = [history, draft.id, draft.remoteId, draft.date, draft.title, exercise.id, exercise.name, exercise.canonicalName, selection];
    if (!key || key.some((value, index) => value !== nextKey[index])) {
      key = nextKey;
      weights = calculate(draft, exercise, history);
    }
    return weights;
  };
}
