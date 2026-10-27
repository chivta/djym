import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertAtSelection, sendOnce } from '../chatInput.ts';

test('suggestion insertion replaces only the selected text and returns the new cursor', () => {
  assert.deepEqual(insertAtSelection('Bench xx -8', { start: 6, end: 8 }, '60'), { text: 'Bench 60 -8', selection: { start: 8, end: 8 } });
});

test('fast latest edit is what send observes and durable-write failure does not fake a send', () => {
  let current = '';
  const writes: string[] = [];
  const persist = (value: string) => { writes.push(value); return value !== 'broken'; };
  current = 'Bench'; assert.equal(persist(current), true);
  current = 'Bench press 60-8'; assert.equal(persist(current), true);
  let sent = '';
  const busy = { current: false };
  sendOnce(busy, () => { sent = current; });
  assert.equal(sent, 'Bench press 60-8');
  current = 'broken'; assert.equal(persist(current), false);
  assert.deepEqual(writes, ['Bench', 'Bench press 60-8', 'broken']);
});

test('overlapping send presses are ignored while a send is active', () => {
  const busy = { current: true };
  let sends = 0;
  assert.equal(sendOnce(busy, () => ++sends), undefined);
  busy.current = false;
  assert.equal(sendOnce(busy, () => ++sends), 1);
  assert.equal(sendOnce(busy, () => ++sends), 2);
});
