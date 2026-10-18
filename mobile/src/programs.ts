import { MAX_TEXT_LENGTH, MAX_REPS } from './model.ts';
import type { Draft, DraftExercise, DraftSet, Workout } from './model.ts';
import { ApiError, record, text, timestamp } from './api.ts';

export const MAX_PROGRAM_EXERCISES = 100;
export const MAX_PROGRAM_SETS = 100;
export type ProgramEntry = { name: string; set_count: number; target_reps: number | null };
export type Program = { id: string; name: string; entries: ProgramEntry[]; updated_at?: string };
export function normalizeName(name: string): string { return name.trim().replace(/\s+/g, ' ').toLowerCase(); }
export function validateProgram(p: Program): boolean {
  return !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(p.id) ||
    !p.name.trim() || p.name.length > MAX_TEXT_LENGTH || !p.entries.length || p.entries.length > MAX_PROGRAM_EXERCISES ||
    p.entries.some(e => !e.name.trim() || e.name.length > MAX_TEXT_LENGTH || !Number.isInteger(e.set_count) || e.set_count < 1 || e.set_count > MAX_PROGRAM_SETS ||
      (e.target_reps !== null && (!Number.isInteger(e.target_reps) || e.target_reps < 1 || e.target_reps > MAX_REPS)));
}
export function parseProgram(value: unknown): Program {
  const v = record(value);
  if (!Array.isArray(v.entries)) throw new ApiError('invalid_response');
  const p: Program = { id: text(v.id), name: text(v.name), updated_at: timestamp(v.updated_at), entries: v.entries.map(value => {
    const e = record(value);
    if (typeof e.set_count !== 'number' || (e.target_reps !== null && typeof e.target_reps !== 'number')) throw new ApiError('invalid_response');
    return { name: text(e.name), set_count: e.set_count, target_reps: e.target_reps as number | null };
  }) };
  if (validateProgram(p)) throw new ApiError('invalid_response');
  return p;
}
export function matchingProgram(d: Draft, programs: Program[]): Program | undefined {
  const name = normalizeName(d.title);
  return name ? programs.find(p => normalizeName(p.name) === name) : undefined;
}
export function previousWeights(d: Draft, exercise: Pick<DraftExercise, 'name' | 'canonicalName'>, history: Workout[]): number[] {
  const name = normalizeName(d.title);
  if (!name) return [];
  const names = [exercise.name, exercise.canonicalName ?? ''].map(normalizeName).filter(Boolean);
  for (const w of history.filter(w => w.id !== d.id && (!d.remoteId || w.remoteId !== d.remoteId) && w.date < d.date && normalizeName(w.title) === name).sort((a,b) => b.date.localeCompare(a.date))) {
    const e = w.exercises.find(e => [e.name, e.canonicalName ?? ''].some(n => names.includes(normalizeName(n))));
    const weights = e?.sets.filter(s => Number.isFinite(s.kg) && s.kg >= 0 && s.reps > 0).map(s => s.kg) ?? [];
    if (weights.length) return weights;
  }
  return [];
}
export function weightHint(weights: number[], index: number): string { return String(weights[index] ?? weights.at(-1) ?? 0); }
export function acceptReps(set: DraftSet, reps: string, suggestedWeight: string): DraftSet {
  return { ...set, reps, ...(reps.trim() && !set.kg.trim() ? { kg: suggestedWeight } : {}) };
}
export function plannedSets(count: number, uuid: () => string): DraftSet[] {
  return Array.from({ length: count }, () => ({ id: uuid(), kg: '', reps: '', planned: true }));
}

export function exerciseSets(entry: DraftExercise, count: number): DraftSet[] {
  const sets = [...entry.sets];
  while (sets.length < count) {
    let id = `${entry.id}:planned:${sets.length}`;
    while (sets.some(s => s.id === id)) id += ':next';
    sets.push({ id, kg: '', reps: '', planned: true });
  }
  return sets;
}
