import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutoSync, type AutoSyncClock, type AutoSyncTimerHandle } from '../autoSync.ts';
import type { ErrorCode } from '../api.ts';

class FakeClock implements AutoSyncClock {
  now = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, delayMs: number): AutoSyncTimerHandle {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id as AutoSyncTimerHandle;
  }
  clearTimeout(handle: AutoSyncTimerHandle) { this.timers.delete(handle as number); }
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const item = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!item || item[1].at > end) break;
      this.timers.delete(item[0]); this.now = item[1].at; item[1].callback();
      await flush();
    }
    this.now = end; await flush();
  }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const setup = (run: (generation: string | number) => Promise<ErrorCode | null>, clock = new FakeClock()) => ({
  clock, controller: createAutoSync({ run, clock }),
});
test('offline restoration, foregrounding, signed-out pause, mutation coalescing and dispose', async () => {
  const clock = new FakeClock(); const calls: (string | number)[] = [];
  const { controller } = setup(async g => { calls.push(g); return null; }, clock);
  controller.setAccountGeneration('a'); controller.setAppActive(true);
  controller.setConnectivity('offline'); await clock.advance(0); assert.deepEqual(calls, []);
  controller.setConnectivity('online'); controller.request(); controller.request(); await clock.advance(0);
  assert.deepEqual(calls, ['a']);
  controller.setAppActive(false); await clock.advance(10_000); assert.deepEqual(calls, ['a']);
  controller.setAppActive(true); await clock.advance(0); assert.deepEqual(calls, ['a', 'a']);
  controller.setAccountGeneration(null); await clock.advance(10_000); assert.deepEqual(calls, ['a', 'a']);
  controller.dispose(); assert.equal(clock.timers.size, 0);
});
test('event bursts coalesce and retry is bounded; online API outage recovers', async () => {
  const clock = new FakeClock(); let result: ErrorCode | null = 'network'; const calls: number[] = [];
  const { controller } = setup(async () => { calls.push(clock.now); return result; }, clock);
  controller.setAccountGeneration(1); controller.setAppActive(true); controller.setConnectivity('online');
  controller.request(); controller.request(); await clock.advance(0); assert.deepEqual(calls, [0]);
  await clock.advance(999); assert.equal(calls.length, 1);
  await clock.advance(1); assert.deepEqual(calls, [0, 1_000]);
  result = null; await clock.advance(2_000); assert.deepEqual(calls, [0, 1_000, 3_000]);
  controller.dispose();
});
test('auth expiry waits for fresh activation; conflict does not retry', async () => {
  const clock = new FakeClock(); let result: ErrorCode | null = 'unauthorized'; let calls = 0;
  const { controller } = setup(async () => { calls++; return result; }, clock);
  controller.setAccountGeneration('a'); controller.setAppActive(true); await clock.advance(0);
  await clock.advance(120_000); assert.equal(calls, 1);
  result = 'conflict'; controller.setAccountGeneration('a'); await clock.advance(0);
  await clock.advance(120_000); assert.equal(calls, 2); controller.dispose();
});
test('account replacement during inflight work starts new account only after stale completion', async () => {
  const clock = new FakeClock(); const calls: string[] = [];
  let release!: (value: ErrorCode | null) => void;
  const { controller } = setup(g => { calls.push(String(g)); return g === 'old' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(null); }, clock);
  controller.setAccountGeneration('old'); controller.setAppActive(true); await clock.advance(0);
  controller.setAccountGeneration('new'); await clock.advance(0); assert.deepEqual(calls, ['old']);
  release('network'); await flush(); await clock.advance(0); assert.deepEqual(calls, ['old', 'new']);
  controller.dispose();
});
test('local mutation during a run is coalesced into one follow-up', async () => {
  const clock = new FakeClock(); let release!: (value: ErrorCode | null) => void; let calls = 0;
  const { controller } = setup(() => { calls++; return calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(null); }, clock);
  controller.setAccountGeneration(1); controller.setAppActive(true); await clock.advance(0);
  controller.request(); controller.request(); release('network'); await flush(); await clock.advance(0);
  assert.equal(calls, 2); controller.dispose();
});
test('stale completion and timers cannot run after disposal', async () => {
  const clock = new FakeClock(); let release!: (value: ErrorCode | null) => void; let calls = 0;
  const { controller } = setup(() => { calls++; return new Promise(resolve => { release = resolve; }); }, clock);
  controller.setAccountGeneration(1); controller.setAppActive(true); await clock.advance(0);
  controller.dispose(); release('network'); await flush(); await clock.advance(120_000); assert.equal(calls, 1);
});
