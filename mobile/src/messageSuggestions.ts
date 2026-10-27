import type { Draft, DraftExercise, Workout } from './model.ts';
import { normalizeName, matchingProgram, loadProgramExercises } from './programs.ts';
import type { Program } from './programs.ts';

export type HistorySuggestionIndex = {
  weightsFor(exercise: Pick<DraftExercise, 'name' | 'canonicalName'>): number[];
  recentExercises(): { name: string; canonicalName?: string }[];
  scannedWorkouts: number;
  sortedWorkouts: number;
  historyRecordsRead: number;
};
/** Build once when workout/history context changes; lookups never rescan or sort history. */
export function buildHistorySuggestionIndex(draft: Draft, history: Workout[]): HistorySuggestionIndex {
  const title = normalizeName(draft.title);
  const eligible = history.filter(w => w.id !== draft.id && (!draft.remoteId || w.remoteId !== draft.remoteId) && w.date <= draft.date && (!title || normalizeName(w.title) === title));
  eligible.sort((a, b) => b.date.localeCompare(a.date) || (a.remoteId !== undefined && b.remoteId !== undefined ? b.remoteId - a.remoteId : 0));
  const byName = new Map<string, { workout: number; entry: number; weights: number[] }[]>();
  const recent: { name: string; canonicalName?: string }[] = [];
  let historyRecordsRead = 0;
  for (let wi = 0; wi < eligible.length; wi++) {
    const workout = eligible[wi]; const firstByName = new Map<string, { entry: number; weights: number[] }>();
    for (let ei = 0; ei < workout.exercises.length; ei++) {
      const entry = workout.exercises[ei];
      const usable = entry.sets.filter(s => Number.isFinite(s.kg) && s.kg >= 0 && s.reps > 0).map(s => s.kg);
      const names = Array.from(new Set([entry.name, entry.canonicalName ?? ''].map(normalizeName).filter(Boolean)));
      for (const name of names) if (!firstByName.has(name)) firstByName.set(name, { entry: ei, weights: usable });
      if (usable.length && names.length && !recent.some(e => names.includes(normalizeName(e.name)) || (!!e.canonicalName && names.includes(normalizeName(e.canonicalName))))) recent.push({ name: entry.name, ...(entry.canonicalName ? { canonicalName: entry.canonicalName } : {}) });
    }
    for (const [name, match] of Array.from(firstByName.entries())) {
      const records = byName.get(name) ?? []; records.push({ workout: wi, ...match }); byName.set(name, records);
    }
  }
  return {
    weightsFor(exercise) {
      if (!title) return [];
      const records = [exercise.name, exercise.canonicalName ?? ''].map(normalizeName).filter(Boolean).map(name => byName.get(name) ?? []);
      const positions = records.map(() => 0);
      while (true) {
        const current = records.map((list, i) => { historyRecordsRead += 1; return list[positions[i]]; });
        if (current.every(record => !record)) return [];
        const workout = Math.min(...current.map(record => record?.workout ?? Infinity));
        const matching = current.filter((record): record is NonNullable<typeof record> => record?.workout === workout);
        const entry = matching.reduce((best, record) => record.entry < best.entry ? record : best);
        for (let i = 0; i < records.length; i++) if (current[i]?.workout === workout) positions[i]++;
        if (entry.weights.length) return entry.weights;
      }
    },
    recentExercises: () => recent.slice(), scannedWorkouts: history.length, sortedWorkouts: eligible.length,
    get historyRecordsRead() { return historyRecordsRead; },
  };
}

export function messageProgram(draft: Draft, programs: Program[]): Program | undefined { return matchingProgram(draft, programs); }
/** Explicitly accepted templates append only missing exercises and never replace manual or partial work. */
export function appendProgramTemplate(draft: Draft, programs: Program[], uuid: () => string): Draft { return loadProgramExercises(draft, programs, uuid); }
