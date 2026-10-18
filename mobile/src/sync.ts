import { ApiError } from './api.ts';
import type { Api, ErrorCode, Session } from './api.ts';
import type { AccountStore } from './accountStore.ts';

import type { ProgramStore } from './programStore.ts';

type Active = { session: Session; store: AccountStore; api: Api; programs?: ProgramStore };
export function createSync(onChange: () => void, onError: (code: ErrorCode | null) => void) {
  let active: Active | null = null, epoch = 0, running: Promise<void> | null = null, again = false;
  function current(a: Active, e: number) { return active === a && epoch === e; }
  async function sequence() {
    do {
      again = false;
      const a = active, e = epoch;
      if (!a) return;
      try {
        if (Date.parse(a.session.expiresAt) <= Date.now()) throw new ApiError('unauthorized');
        for (;;) {
          if (!current(a, e)) break;
          const row = a.store.rows().find(r => r.pending && !r.error);
          if (!row) break;
          a.store.submitted(row.workout.id);
          const deleting = row.deleted && !!row.workout.remoteId;
          try {
            const ack = await a.api.mutate(a.session, row.workout, deleting);
            if (!current(a, e)) break;
            a.store.acknowledge(row, ack);
          } catch (error) {
            if (!current(a, e)) break;
            if (error instanceof ApiError && error.status === 404 && deleting) a.store.acknowledge(row, null);
            else if (error instanceof ApiError && (error.status === 409 || error.status === 404)) a.store.failure(row, error.code);
            else throw error;
          }
          onChange();
        }
        if (!current(a, e)) continue;
        if (a.programs) {
          for (;;) {
            if (!current(a, e)) break;
            const row = a.programs.rows().find(r => r.pending && !r.error);
            if (!row) break;
            a.programs.submitted(row.program.id);
            const deleting = row.deleted && !!row.program.updated_at;
            try {
              const ack = await a.api.mutateProgram(a.session, row.program, deleting);
              if (!current(a, e)) break;
              a.programs.acknowledge(row, ack);
            } catch (error) {
              if (!current(a, e)) break;
              if (error instanceof ApiError && error.status === 404 && deleting) a.programs.acknowledge(row, null);
              else if (error instanceof ApiError && (error.status === 409 || error.status === 404)) a.programs.failure(row, error.code);
              else throw error;
            }
            onChange();
          }
          if (!current(a, e)) continue;
          const programs = await a.api.programs(a.session);
          if (!current(a, e)) continue;
          a.programs.merge(programs); onChange();
        }
        const workouts = await a.api.history(a.session);
        if (!current(a, e)) continue;
        a.store.merge(workouts);
        onError(null); onChange();
      } catch (error) {
        if (current(a, e)) onError(error instanceof ApiError ? error.code : 'request_failed');
      }
    } while (again);
  }
  function run(): Promise<void> {
    if (running) { again = true; return running; }
    running = sequence().finally(() => { running = null; });
    return running;
  }
  return {
    activate(next: Active | null) { active = next; epoch++; if (running && next) again = true; },
    run,
    async resolveProgram(id: string) {
      const a = active, e = epoch;
      if (!a?.programs) return;
      const programs = a.programs, row = programs.rows().find(r => r.program.id === id);
      if (!row) return;
      const draftBefore = JSON.stringify(programs.draft());
      while (running) await running;
      if (!current(a, e)) return;
      const unchanged = () => programs.rows().find(r => r.program.id === id)?.generation === row.generation && JSON.stringify(programs.draft()) === draftBefore;
      if (!unchanged()) { onError('conflict'); return; }
      running = (async () => {
        try {
          const all = await a.api.programs(a.session);
          if (!current(a, e)) return;
          if (!unchanged()) throw new ApiError('conflict');
          programs.resolve(id, all.find(p => p.id === id) ?? null);
          onError(null); onChange();
        } catch (error) { if (current(a, e)) onError(error instanceof ApiError ? error.code : 'request_failed'); }
      })().finally(() => { running = null; if (again) { again = false; void run(); } });
      await running;
    },
    async resolve(id: string) {
      // Serialize resolution with writes/history, including an old account's in-flight request.
      const a = active, e = epoch;
      if (!a) return;
      const row = a.store.rows().find(r => r.workout.id === id);
      if (!row) return;
      const draftBefore = JSON.stringify(a.store.load().draft);
      while (running) await running;
      if (!current(a, e)) return;
      if (a.store.rows().find(r => r.workout.id === id)?.generation !== row.generation || JSON.stringify(a.store.load().draft) !== draftBefore) {
        onError('conflict'); return;
      }
      // Occupy the same concurrency gate while the latest server snapshot is fetched.
      running = (async () => {
        try {
          const all = await a.api.history(a.session);
          if (!current(a, e)) return;
          const now = a.store.rows().find(r => r.workout.id === id);
          if (now?.generation !== row.generation || JSON.stringify(a.store.load().draft) !== draftBefore) throw new ApiError('conflict');
          a.store.resolve(id, all.find(w => w.remoteId === row.workout.remoteId || (w.source === 'mobile' && w.sourceRef === row.workout.sourceRef)) ?? null);
          onError(null); onChange();
        } catch (error) { if (current(a, e)) onError(error instanceof ApiError ? error.code : 'request_failed'); }
      })().finally(() => { running = null; if (again) { again = false; void run(); } });
      await running;
    },
  };
}
