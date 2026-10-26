import type { Draft } from './model.ts';

export function applyDraftChange(current: Draft, update: (current: Draft) => Draft): Draft {
  return update(current);
}
