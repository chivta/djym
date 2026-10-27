import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../storage.ts';
import { newDraft } from '../model.ts';
import { createChatMessageHandlers, insertAtSelection, sendOnce } from '../chatInput.ts';

function adapter(db: DatabaseSync) {
  return {
    execSync(sql: string) { db.exec(sql); },
    runSync(sql: string, ...params: (string | number)[]) { db.prepare(sql).run(...params); },
    getFirstSync<T>(sql: string, ...params: (string | number)[]): T | null { return (db.prepare(sql).get(...params) as T | undefined) ?? null; },
    getAllSync<T>(sql: string): T[] { return db.prepare(sql).all() as T[]; },
    withTransactionSync(action: () => void) { db.exec('BEGIN'); try { action(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } },
  };
}

test('suggestion insertion replaces only the selected text and returns the new cursor', () => {
  assert.deepEqual(insertAtSelection('Bench xx -8', { start: 6, end: 8 }, '60'), { text: 'Bench 60 -8', selection: { start: 8, end: 8 } });
});

test('production message handlers persist rapid edits, save the latest text, and clear only after durable success', context => {
  const db = new DatabaseSync(':memory:'); context.after(() => db.close());
  const store = createStore(adapter(db));
  let current = newDraft('chat-workout');
  const handlers = createChatMessageHandlers({ current: () => current, setCurrent: value => { current = value ?? newDraft('next'); },
    createDraft: () => newDraft('chat-workout'), writeDraft: value => store.writeDraft(value), saveDraft: value => { store.save(value); } });
  assert.equal(handlers.onText('Bench'), true);
  assert.equal(handlers.onText('Bench press 60-8'), true);
  assert.equal(store.load().draft?.messageText, 'Bench press 60-8');
  assert.equal(handlers.onSend('Bench press 60-8'), true);
  assert.equal(store.load().draft, null);
  assert.equal(store.load().workouts[0].exercises[0].sets[0].kg, 60);
});

test('production message handler retains exact draft when durable workout save fails', context => {
  const db = new DatabaseSync(':memory:'); context.after(() => db.close());
  const store = createStore(adapter(db));
  let current = newDraft('chat-workout');
  const handlers = createChatMessageHandlers({ current: () => current, setCurrent: value => { current = value ?? newDraft('next'); },
    createDraft: () => newDraft('chat-workout'), writeDraft: value => store.writeDraft(value), saveDraft: value => { store.save(value); } });
  assert.equal(handlers.onText('Bench press 60-8'), true);
  db.exec("CREATE TRIGGER fail_chat_save BEFORE DELETE ON draft BEGIN SELECT RAISE(ABORT, 'disk_failure'); END;");
  assert.equal(handlers.onSend('Bench press 60-8'), false);
  assert.equal(store.load().workouts.length, 0);
  assert.equal(store.load().draft?.messageText, 'Bench press 60-8');
});

test('production draft write failure is returned without losing the latest in-memory text', context => {
  const db = new DatabaseSync(':memory:'); context.after(() => db.close());
  const store = createStore(adapter(db));
  let current = newDraft('chat-workout');
  const handlers = createChatMessageHandlers({ current: () => current, setCurrent: value => { current = value ?? newDraft('next'); },
    createDraft: () => newDraft('chat-workout'), writeDraft: value => store.writeDraft(value), saveDraft: value => { store.save(value); } });
  db.exec("CREATE TRIGGER fail_chat_draft BEFORE INSERT ON draft BEGIN SELECT RAISE(ABORT, 'disk_failure'); END;");
  assert.equal(handlers.onText('not lost'), false);
  assert.equal(current.messageText, 'not lost');
  db.exec('DROP TRIGGER fail_chat_draft');
  assert.equal(handlers.onText(current.messageText!), true);
  assert.equal(store.load().draft?.messageText, 'not lost');
});

test('overlapping send presses are ignored while a send is active', () => {
  const busy = { current: true };
  let sends = 0;
  assert.equal(sendOnce(busy, () => ++sends), undefined);
  busy.current = false;
  assert.equal(sendOnce(busy, () => ++sends), 1);
  assert.equal(sendOnce(busy, () => ++sends), 2);
});
