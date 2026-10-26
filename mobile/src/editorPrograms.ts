import type { Program } from './programs.ts';
import type { ProgramStore } from './programStore.ts';

export function loadProgramSnapshot(store: Pick<ProgramStore, 'load'> | null): Program[] {
  return store?.load() ?? [];
}
