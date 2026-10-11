export const MAX_WEIGHT = 9999.99;
export const MAX_REPS = 9999;
export const MAX_TEXT_LENGTH = 2000;
const WEIGHT_PATTERN = /^\d+(?:[.,]\d{1,2})?$/;
const REPS_PATTERN = /^\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type DraftSet = { id: string; kg: string; reps: string };
export type DraftExercise = { id: string; name: string; sets: DraftSet[] };
export type Draft = {
  id: string;
  date: string;
  title: string;
  notes: string;
  exercises: DraftExercise[];
};
export type Workout = Omit<Draft, 'exercises'> & {
  exercises: { id: string; name: string; sets: { id: string; kg: number; reps: number }[] }[];
};
export type ValidationCode = 'date' | 'exercises' | 'name' | 'sets' | 'weight' | 'reps';
export type ValidationIssue = { code: ValidationCode; exercise?: number; set?: number };

export function today(now = new Date()): string {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

export function isDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function newDraft(id: string): Draft {
  return { id, date: today(), title: '', notes: '', exercises: [] };
}

export function validateDraft(draft: Draft): ValidationIssue | null {
  if (!isDate(draft.date)) return { code: 'date' };
  if (!draft.exercises.length) return { code: 'exercises' };
  for (const [exercise, entry] of draft.exercises.entries()) {
    if (!entry.name.trim()) return { code: 'name', exercise };
    if (!entry.sets.length) return { code: 'sets', exercise };
    for (const [set, value] of entry.sets.entries()) {
      const kg = value.kg.trim();
      const reps = value.reps.trim();
      if (!WEIGHT_PATTERN.test(kg) || Number(kg.replace(',', '.')) > MAX_WEIGHT) return { code: 'weight', exercise, set };
      if (!REPS_PATTERN.test(reps) || Number(reps) < 1 || Number(reps) > MAX_REPS) return { code: 'reps', exercise, set };
    }
  }
  return null;
}

export function toWorkout(draft: Draft): Workout {
  const issue = validateDraft(draft);
  if (issue) throw new Error(issue.code);
  return {
    ...draft,
    title: draft.title.trim(),
    notes: draft.notes.trim(),
    exercises: draft.exercises.map(entry => ({
      ...entry,
      name: entry.name.trim(),
      sets: entry.sets.map(set => ({ ...set, kg: Number(set.kg.trim().replace(',', '.')), reps: Number(set.reps) })),
    })),
  };
}

export function toDraft(workout: Workout): Draft {
  return {
    ...workout,
    exercises: workout.exercises.map(entry => ({
      ...entry,
      sets: entry.sets.map(set => ({ ...set, kg: String(set.kg), reps: String(set.reps) })),
    })),
  };
}

// Stored JSON is a boundary. Reject damaged data instead of replacing it with an empty log.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function hasHeader(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.date === 'string' && typeof value.title === 'string' && typeof value.notes === 'string' && Array.isArray(value.exercises);
}
function hasEntries(value: Record<string, unknown>, saved: boolean): boolean {
  return (value.exercises as unknown[]).every(entry => isRecord(entry) && typeof entry.id === 'string' &&
    typeof entry.name === 'string' && Array.isArray(entry.sets) && entry.sets.every(set =>
      isRecord(set) && typeof set.id === 'string' && typeof set.kg === (saved ? 'number' : 'string') && typeof set.reps === (saved ? 'number' : 'string')));
}
export function parseDraft(json: string): Draft {
  try {
    const value: unknown = JSON.parse(json);
    if (!hasHeader(value) || !hasEntries(value, false)) throw new Error('invalid_storage');
    return value as Draft;
  } catch {
    throw new Error('invalid_storage');
  }
}
export function parseWorkout(json: string): Workout {
  try {
    const value: unknown = JSON.parse(json);
    if (!hasHeader(value) || !hasEntries(value, true)) throw new Error('invalid_storage');
    const workout = value as Workout;
    if (validateDraft(toDraft(workout))) throw new Error('invalid_storage');
    return workout;
  } catch {
    throw new Error('invalid_storage');
  }
}

export function setCount(workout: Workout): number {
  return workout.exercises.reduce((count, entry) => count + entry.sets.length, 0);
}
