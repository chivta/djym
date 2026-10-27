import type { ErrorCode } from './api.ts';

export type Connectivity = 'online' | 'offline' | 'unknown';

export type AutoSyncTimerHandle = number;

export interface AutoSyncClock {
  setTimeout(callback: () => void, delayMs: number): AutoSyncTimerHandle;
  clearTimeout(handle: AutoSyncTimerHandle): void;
}

export interface AutoSyncOptions {
  /** Resolve to the current sync result. Do not adapt createSync.run()'s Promise<void> as success. */
  run(generation: string | number): Promise<ErrorCode | null>;
  clock?: AutoSyncClock;
}

export interface AutoSyncController {
  /** Call on each fresh account/session activation; changed generations invalidate old work. */
  setAccountGeneration(generation: string | number | null): void;
  setAppActive(active: boolean): void;
  setConnectivity(connectivity: Connectivity): void;
  /** Request immediate work after a successful local mutation. */
  request(): void;
  dispose(): void;
}

export const AUTO_SYNC_RETRY_BASE_MS = 1_000;
export const AUTO_SYNC_RETRY_MAX_MS = 60_000;
export const AUTO_SYNC_REFRESH_MS = 5 * 60_000;

let nextRealTimer = 0;
const realTimers = new Map<number, ReturnType<typeof globalThis.setTimeout>>();
const realClock: AutoSyncClock = {
  setTimeout(callback, delayMs) {
    const id = ++nextRealTimer;
    realTimers.set(id, globalThis.setTimeout(() => { realTimers.delete(id); callback(); }, delayMs));
    return id;
  },
  clearTimeout(id) {
    const handle = realTimers.get(id);
    if (handle !== undefined) globalThis.clearTimeout(handle);
    realTimers.delete(id);
  },
};

export function createAutoSync(options: AutoSyncOptions): AutoSyncController {
  const clock = options.clock ?? realClock;
  let generation: string | number | null = null;
  let activation = 0;
  let active = false;
  let connectivity: Connectivity = 'unknown';
  let disposed = false;
  let running = false;
  let authBlocked = false;
  let failures = 0;
  let timer: AutoSyncTimerHandle | undefined;
  let timerKind: 'retry' | 'refresh' | 'immediate' | null = null;
  let queuedImmediate = false;

  const eligible = () => !disposed && generation !== null && active && connectivity !== 'offline' && !authBlocked;
  function clearTimer() {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    timerKind = null;
  }
  function schedule(kind: 'retry' | 'refresh' | 'immediate', delay: number) {
    if (!eligible()) return;
    // Immediate triggers supersede a delayed refresh/retry; bursts share one timer.
    if (timer !== undefined) {
      if (kind !== 'immediate' || timerKind === 'immediate') return;
      clearTimer();
    }
    timerKind = kind;
    timer = clock.setTimeout(() => {
      timer = undefined;
      timerKind = null;
      void execute();
    }, delay);
  }
  function settleForNext() {
    if (!eligible()) return;
    if (queuedImmediate) {
      queuedImmediate = false;
      schedule('immediate', 0);
    } else if (timer === undefined) schedule('refresh', AUTO_SYNC_REFRESH_MS);
  }
  async function execute() {
    if (running || !eligible()) return;
    const selected = generation;
    const selectedActivation = activation;
    if (selected === null) return;
    running = true;
    queuedImmediate = false;
    try {
      const result = await options.run(selected);
      if (disposed || selected !== generation || selectedActivation !== activation) return;
      if (result === 'unauthorized' || result === 'login_expired') {
        authBlocked = true;
        clearTimer();
      } else if (result !== null && result !== 'conflict' && result !== 'workout_not_found' && result !== 'program_not_found' && result !== 'configuration' && result !== 'invalid_response') {
        failures += 1;
        const delay = Math.min(AUTO_SYNC_RETRY_MAX_MS, AUTO_SYNC_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 6));
        schedule('retry', delay);
      } else {
        failures = 0;
        settleForNext();
      }
    } catch {
      if (!disposed && selected === generation && selectedActivation === activation) {
        failures += 1;
        schedule('retry', Math.min(AUTO_SYNC_RETRY_MAX_MS, AUTO_SYNC_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 6)));
      }
    } finally {
      running = false;
      // A replaced account or a coalesced mutation waits for this request, then starts fresh.
      if (eligible() && (selected !== generation || selectedActivation !== activation || queuedImmediate)) schedule('immediate', 0);
    }
  }
  return {
    setAccountGeneration(next) {
      if (disposed) return;
      activation += 1;
      const changed = next !== generation;
      generation = next;
      authBlocked = false;
      failures = 0;
      queuedImmediate = false;
      clearTimer();
      if (next !== null && (changed || !running)) schedule('immediate', 0);
    },
    setAppActive(next) {
      if (disposed || active === next) return;
      active = next;
      if (!active) clearTimer();
      else schedule('immediate', 0);
    },
    setConnectivity(next) {
      if (disposed || connectivity === next) return;
      const wasOffline = connectivity === 'offline';
      connectivity = next;
      if (!eligible()) clearTimer();
      else if (wasOffline || next === 'online') schedule('immediate', 0);
    },
    request() {
      if (!eligible()) return;
      if (running) queuedImmediate = true;
      else schedule('immediate', 0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation = null;
      queuedImmediate = false;
      clearTimer();
    },
  };
}
