export const MAX_WEIGHT = 9999.99;
export const MAX_REPS = 9999;
export const MAX_TEXT_LENGTH = 2000;
const WEIGHT_PATTERN = /^\d+(?:[.,]\d{1,2})?$/;
const REPS_PATTERN = /^\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type DraftSet = { id: string; kg: string; reps: string; planned?: boolean };
export type DraftExercise = { id: string; name: string; canonicalName?: string; suggested?: boolean; sets: DraftSet[] };
export const WORKOUT_TYPES = ['push+pull', 'push+lower', 'lower', 'upper', 'push', 'pull', 'full body', 'workout A', 'workout B', 'день 1', 'день 2', 'руки', 'рест'] as const;
export type Metadata = {
  legacyType?: string; remoteId?: number; revision?: string; source?: string; sourceRef?: string;
  kcal?: number | null; proteinG?: number | null; startedAt?: string | null; finishedAt?: string | null;
};
export type Draft = Metadata & {
  id: string;
  date: string;
  title: string;
  notes: string;
  exercises: DraftExercise[];
  /** Exact unfinished message input; never included in a saved Workout. */
  messageText?: string;
};
export type Workout = Omit<Draft, 'exercises' | 'messageText'> & {
  exercises: { id: string; name: string; canonicalName?: string; sets: { id: string; kg: number; reps: number }[] }[];
};
export type ValidationCode = 'title' | 'date' | 'exercises' | 'name' | 'sets' | 'weight' | 'reps';
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
  return { id, date: today(), title: '', legacyType: '', notes: '', exercises: [] };
}

// Older cached drafts used title as the closed type; capture it before a free rename.
export function renameDraft(draft: Draft, title: string): Draft {
  return { ...draft, title, legacyType: draft.legacyType ?? WORKOUT_TYPES.find(t => t === draft.title) ?? '' };
}

// Only explicitly marked planned data is disposable; historical empty entries remain intact.
export function materializeDraft(draft: Draft): Draft {
  return {
    ...draft,
    exercises: draft.exercises
      .filter(e => !e.suggested || e.sets.some(s => s.kg.trim() || s.reps.trim()))
      .map(({ suggested, ...e }) => ({
        ...e,
        sets: e.sets.filter(s => !s.planned || s.kg.trim() || s.reps.trim()).map(({ planned, ...s }) => s),
      })),
  };
}

export function validateDraft(draft: Draft): ValidationIssue | null {
  const original = draft;
  draft = materializeDraft(draft);
  if (draft.title.length > MAX_TEXT_LENGTH) return { code: 'title' };
  if (!isDate(draft.date)) return { code: 'date' };
  if (!draft.exercises.length && !draft.remoteId) return { code: 'exercises' };
  for (const entry of draft.exercises) {
    const exercise = original.exercises.findIndex(e => e.id === entry.id);
    if (!entry.name.trim()) return { code: 'name', exercise };
    if (!entry.sets.length && !draft.remoteId) return { code: 'sets', exercise };
    for (const value of entry.sets) {
      const set = original.exercises[exercise].sets.findIndex(s => s.id === value.id);
      const kg = value.kg.trim();
      const reps = value.reps.trim();
      if (!WEIGHT_PATTERN.test(kg) || Number(kg.replace(',', '.')) > MAX_WEIGHT) return { code: 'weight', exercise, set };
      if (!REPS_PATTERN.test(reps) || !Number.isSafeInteger(Number(reps)) || Number(reps) < 1 || (!draft.remoteId && Number(reps) > MAX_REPS)) return { code: 'reps', exercise, set };
    }
  }
  return null;
}

export function toWorkout(draft: Draft): Workout {
  const issue = validateDraft(draft);
  if (issue) throw new Error(issue.code);
  draft = materializeDraft(draft);
  const { messageText: _messageText, ...savedDraft } = draft;
  return {
    ...savedDraft,
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
function hasMetadata(value: Record<string, unknown>): boolean {
  const time = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
  if (value.remoteId !== undefined && (typeof value.remoteId !== 'number' || !Number.isSafeInteger(value.remoteId) || value.remoteId < 1 || !time(value.revision))) return false;
  if (value.revision !== undefined && !time(value.revision)) return false;
  for (const key of ['source', 'sourceRef', 'legacyType']) if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  for (const key of ['kcal', 'proteinG']) if (value[key] != null && (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) return false;
  for (const key of ['startedAt', 'finishedAt']) if (value[key] != null && !time(value[key])) return false;
  return true;
}
function hasEntries(value: Record<string, unknown>, saved: boolean): boolean {
  return (value.exercises as unknown[]).every(entry => isRecord(entry) && typeof entry.id === 'string' &&
    typeof entry.name === 'string' && (entry.canonicalName === undefined || typeof entry.canonicalName === 'string') &&
    (entry.suggested === undefined || typeof entry.suggested === 'boolean') && Array.isArray(entry.sets) && entry.sets.every(set =>
      isRecord(set) && typeof set.id === 'string' && (set.planned === undefined || typeof set.planned === 'boolean') && typeof set.kg === (saved ? 'number' : 'string') && typeof set.reps === (saved ? 'number' : 'string')));
}
export function parseDraft(json: string): Draft {
  try {
    const value: unknown = JSON.parse(json);
    if (!hasHeader(value) || !hasEntries(value, false) || !hasMetadata(value) ||
      (value.messageText !== undefined && (typeof value.messageText !== 'string' || value.messageText.length > MAX_TEXT_LENGTH))) throw new Error('invalid_storage');
    return value as Draft;
  } catch {
    throw new Error('invalid_storage');
  }
}
export function parseWorkout(json: string): Workout {
  try {
    const value: unknown = JSON.parse(json);
    if (!hasHeader(value) || !hasEntries(value, true) || !hasMetadata(value) || 'messageText' in value ||
      (value.exercises as unknown[]).some(entry => isRecord(entry) && ('suggested' in entry || (Array.isArray(entry.sets) && entry.sets.some(set => isRecord(set) && 'planned' in set))))) throw new Error('invalid_storage');
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
