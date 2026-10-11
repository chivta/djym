import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../storage.ts';
import { accountKey, createAccountStore } from '../accountStore.ts';
import { ApiError, apiURL, createApi, remoteWorkout, workoutBody } from '../api.ts';
import type { Session } from '../api.ts';
import { createAuth, LOGIN_KEY, SESSION_KEY } from '../auth.ts';
import { createSync } from '../sync.ts';
import { toDraft, toWorkout } from '../model.ts';
import type { Draft } from '../model.ts';

const base = 'https://fake.invalid/api';
const revision = '2026-10-11T12:00:00.123456Z';
const newer = '2026-10-11T12:01:00.123456Z';
const session: Session = { apiURL: base, userId: 1, token: 'fake-native-token', expiresAt: '2099-01-01T00:00:00Z' };
function fixture(id = randomUUID()): Draft {
  return { id, date: '2026-10-11', title: 'upper', notes: 'session', exercises: [{ id: 'e', name: 'Bench as written', sets: [{ id: 's', kg: '60.25', reps: '8' }] }] };
}
function wire(id = 1, source = 'telegram', sourceRef = 'bot-ref') {
  return { id, performed_on: '2026-10-11', type: 'upper', kcal: 2200, protein_g: 130, note: 'original',
    started_at: '2026-10-11T10:00:00Z', finished_at: '2026-10-11T11:00:00Z', source, source_ref: sourceRef,
    raw_text: 'original raw', updated_at: revision,
    entries: [{ position: 0, name_as_written: 'Written bench', exercise: 'Bench press', sets: [{ weight: '60.25', reps: 8 }] }] };
}
function adapter(db: DatabaseSync) {
  return {
    execSync(sql: string) { db.exec(sql); },
    runSync(sql: string, ...params: (string | number)[]) { db.prepare(sql).run(...params); },
    getFirstSync<T>(sql: string, ...params: (string | number)[]): T | null { return (db.prepare(sql).get(...params) as T | undefined) ?? null; },
    getAllSync<T>(sql: string, ...params: (string | number)[]): T[] { return db.prepare(sql).all(...params) as T[]; },
    withTransactionSync(action: () => void) { db.exec('BEGIN'); try { action(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
}
function setup() {
  const db = new DatabaseSync(':memory:');
  const connection = adapter(db);
  const store = createAccountStore(connection, accountKey(session));
  return { db, connection, store };
}
function json(v: unknown, status = 200) { return new Response(status === 204 ? null : JSON.stringify(v), { status }); }
function fake(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {})) as typeof fetch;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function vault() {
  const data = new Map<string, string>();
  return { data, async get(k: string) { return data.get(k) ?? null; }, async set(k: string, v: string) { data.set(k,v); }, async remove(k: string) { data.delete(k); } };
}
function runner(store: ReturnType<typeof createAccountStore>, fetcher: typeof fetch, s = session) {
  const errors: (string | null)[] = [];
  const sync = createSync(() => {}, code => errors.push(code));
  const api = createApi(base, fetcher);
  sync.activate({ session: s, store, api });
  return { sync, errors, api };
}

test('storage: v1 migration preserves unassigned records and draft; explicit import normalizes legacy names atomically', () => {
  const { db, connection, store } = setup();
  try {
    // Build the actual previous schema, not a mocked migration.
    db.exec('DROP TABLE account_workouts; DROP TABLE account_drafts; PRAGMA user_version = 1;');
    const d = { ...fixture(), title: 'My legacy name' };
    db.prepare('INSERT INTO workouts VALUES (?,?,?)').run(d.id, d.date, JSON.stringify(toWorkout(d)));
    db.prepare('INSERT INTO draft VALUES (1,?)').run(JSON.stringify({ ...fixture(), title: 'UPPER' }));
    const migrated = createAccountStore(connection, accountKey(session));
    assert.equal(migrated.load().workouts.length, 0);
    assert.equal(migrated.legacy().workouts[0].title, 'My legacy name');
    migrated.writeDraft(fixture());
    assert.throws(() => migrated.importLegacy(randomUUID), /draft_exists/);
    assert.equal(migrated.legacy().workouts.length, 1);
    assert.equal(migrated.load().workouts.length, 0);
    migrated.clearDraft(); migrated.importLegacy(randomUUID);
    assert.equal(migrated.load().workouts[0].title, '');
    assert.equal(migrated.load().workouts[0].notes, 'My legacy name\nsession');
    assert.equal(migrated.load().draft?.title, 'upper');
    assert.equal(migrated.legacy().workouts.length, 0);
    assert.equal(migrated.legacy().draft, null);
    assert.equal(migrated.rows()[0].pending, true);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.equal(store.load().workouts.length, 1);
  } finally { db.close(); }
});

test('storage: API URL/user isolation and account restoration retain pending workouts and drafts', () => {
  const { db, connection, store } = setup();
  try {
    store.save(fixture()); store.writeDraft(fixture());
    for (const s of [{ ...session, userId: 2 }, { ...session, apiURL: 'https://other.invalid/api' }]) {
      const other = createAccountStore(connection, accountKey(s));
      assert.deepEqual(other.load(), { workouts: [], draft: null });
      other.save(fixture());
    }
    const restored = createAccountStore(connection, accountKey(session));
    assert.equal(restored.rows().length, 1); assert.equal(restored.rows()[0].pending, true); assert.ok(restored.load().draft);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM account_workouts').all()).includes(session.token), false);
  } finally { db.close(); }
});

test('storage: save/outbox and draft clearing roll back together on SQLite failure', () => {
  const { db, store } = setup();
  try {
    const d = fixture(); store.writeDraft(d);
    db.exec("CREATE TRIGGER fail BEFORE DELETE ON account_drafts BEGIN SELECT RAISE(ABORT,'disk_failure'); END;");
    assert.throws(() => store.save(d), /disk_failure/);
    assert.equal(store.rows().length, 0); assert.deepEqual(store.load().draft, d);
  } finally { db.close(); }
});

test('API: validates configuration, login, me, ack, history boundaries; rejects repeated pagination cursors', async () => {
  for (const url of [undefined, '', 'not a url', 'ftp://bad', 'https://user:pass@fake.invalid', 'https://fake.invalid/?token=x']) assert.throws(() => apiURL(url), /configuration/);
  assert.equal(apiURL(base + '/'), base);
  const noLeak = createApi(base, fake(() => { throw new Error('must not send a token to another endpoint'); }));
  await assert.rejects(noLeak.history({ ...session, apiURL: 'https://other.invalid/api' }), /request_failed/);
  await assert.rejects(noLeak.poll(''), /request_failed/);
  const invalid = createApi(base, fake(() => json({ bot_url: 'https://evil.invalid', expires_at: revision, nonce: 'n' })));
  await assert.rejects(invalid.start(), /invalid_response/);
  await assert.rejects(createApi(base, fake(() => json({ status: 'confirmed', user_id: 1, session_token: '', expires_at: revision }))).poll('n'), /invalid_response/);
  await assert.rejects(createApi(base, fake(() => json({ user_id: 2 }))).me(session), /invalid_response/);
  await assert.rejects(createApi(base, fake(() => json({ workout_id: 1, created: true, new_exercises: [], updated_at: 'bad' }))).mutate(session, { ...toWorkout(fixture()), sourceRef: randomUUID() }, false), /invalid_response/);
  await assert.rejects(createApi(base, fake(() => json({ workouts: [wire()], next_cursor: 'repeated' }))).history(session), /invalid_response/);
  for (const bad of [{ ...wire(), updated_at: null }, { ...wire(), type: 'invented' }, { ...wire(), kcal: -1 }, { ...wire(), entries: [{ position: 0, name_as_written: 'X', exercise: 'X', sets: [{ weight: '60.123', reps: 1 }] }] }]) assert.throws(() => remoteWorkout(bad), /invalid_response/);
});

test('API: full pagination preserves metadata, written names, and historical empty entries/sets', async () => {
  const urls: string[] = [];
  const empty = { ...wire(2), entries: [] };
  const noSets = { ...wire(3), entries: [{ position: 0, name_as_written: 'Only a name', exercise: 'Resolved', sets: [] }] };
  const api = createApi(base, fake((url, init) => {
    urls.push(url); assert.equal((init.headers as Record<string,string>).Authorization, `Bearer ${session.token}`);
    assert.equal(init.credentials, 'omit');
    return json(url.includes('before=') ? { workouts: [empty, noSets], next_cursor: null } : { workouts: [wire()], next_cursor: 'cursor/a b' });
  }));
  const all = await api.history(session);
  assert.equal(all.length, 3); assert.ok(urls[1].endsWith('?before=cursor%2Fa%20b'));
  assert.equal(all[0].exercises[0].name, 'Written bench');
  assert.equal(all[0].revision, revision);
  for (const w of all) assert.deepEqual(toWorkout(toDraft(w)), w);
  const body = workoutBody({ ...all[0], notes: 'edited' });
  assert.equal(body.kcal, 2200); assert.equal(body.protein_g, 130); assert.equal(body.started_at, wire().started_at);
  assert.equal(body.entries[0].sets[0].weight, '60.25');
  for (const text of ['2026-10-11', 'upper', '2200', '130', 'edited', 'Written bench', '60.25x8', wire().started_at]) assert.ok(body.raw_text.includes(text));
});

test('sync: durable creates reuse UUID source_ref after network loss; fetched retry matches one local row', async () => {
  const { db, connection, store } = setup();
  try {
    const d = fixture(); store.save(d);
    const refs: string[] = [];
    let attempt = 0;
    const fetcher = fake((_url, init) => {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body as string); refs.push(body.source_ref); assert.equal(body.source, 'mobile');
        if (++attempt === 1) throw new Error('lost response');
        return json({ workout_id: 9, updated_at: revision, created: false, new_exercises: [] });
      }
      return json({ workouts: [wire(9, 'mobile', d.id)], next_cursor: null });
    });
    const first = runner(store, fetcher); await first.sync.run();
    assert.deepEqual(first.errors, ['network']); assert.equal(store.rows()[0].pending, true);
    const reopened = createAccountStore(connection, accountKey(session));
    await runner(reopened, fetcher).sync.run();
    assert.deepEqual(refs, [d.id, d.id]); assert.equal(reopened.rows().length, 1);
    assert.equal(reopened.rows()[0].workout.remoteId, 9); assert.equal(reopened.rows()[0].pending, false);
  } finally { db.close(); }
});

test('sync: only one sequence runs; old ack preserves in-flight newer edits and rebases their PUT revision', async () => {
  const { db, store } = setup();
  try {
    const d = fixture(); store.save(d);
    const gate = deferred<Response>(), started = deferred<void>();
    const methods: string[] = [];
    const { sync } = runner(store, fake((_url, init) => {
      methods.push(init.method!);
      if (init.method === 'POST') { started.resolve(); return gate.promise; }
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body as string); assert.equal(body.note, 'new edit'); assert.equal(body.expected_updated_at, revision);
        return json({ workout_id: 9, updated_at: newer, created: false, new_exercises: [] });
      }
      return json({ workouts: [{ ...wire(9, 'mobile', d.id), note: 'new edit', updated_at: newer }], next_cursor: null });
    }));
    const run = sync.run(); await started.promise;
    store.save({ ...d, notes: 'new edit' });
    assert.equal(sync.run(), run); assert.equal(sync.run(), run); assert.deepEqual(methods, ['POST']);
    gate.resolve(json({ workout_id: 9, updated_at: revision, created: true, new_exercises: [] })); await run;
    assert.deepEqual(methods, ['POST', 'PUT', 'GET', 'GET']);
    assert.equal(store.rows()[0].pending, false); assert.equal(store.load().workouts[0].notes, 'new edit');
  } finally { db.close(); }
});

test('sync: delete during create queues durable tombstone, completes create then DELETE; never-created deletion is immediate', async () => {
  const { db, connection, store } = setup();
  try {
    const unsent = fixture(); store.save(unsent); store.remove(unsent.id); assert.equal(store.rows().length, 0);
    const d = fixture(); store.save(d);
    const gate = deferred<Response>(), started = deferred<void>();
    const methods: string[] = [];
    const { sync } = runner(store, fake((_url, init) => {
      methods.push(init.method!);
      if (init.method === 'POST') { started.resolve(); return gate.promise; }
      if (init.method === 'DELETE') { assert.equal(JSON.parse(init.body as string).expected_updated_at, revision); return json(null, 204); }
      return json({ workouts: [], next_cursor: null });
    }));
    const run = sync.run(); await started.promise; store.remove(d.id);
    assert.equal(store.load().workouts.length, 0);
    assert.equal(createAccountStore(connection, accountKey(session)).rows()[0].deleted, true);
    gate.resolve(json({ workout_id: 9, updated_at: revision, created: true, new_exercises: [] })); await run;
    assert.deepEqual(methods, ['POST','DELETE','GET']); assert.equal(store.rows().length, 0);
  } finally { db.close(); }
});

test('sync: delete during PUT uses acknowledged revision, and queued DELETE 404 is successful', async () => {
  const { db, store } = setup();
  try {
    store.merge([remoteWorkout(wire())]);
    const w = store.load().workouts[0]; store.save({ ...toDraft(w), notes: 'edit' });
    const gate = deferred<Response>(), started = deferred<void>();
    const { sync } = runner(store, fake((_url, init) => {
      if (init.method === 'PUT') { started.resolve(); return gate.promise; }
      if (init.method === 'DELETE') { assert.equal(JSON.parse(init.body as string).expected_updated_at, newer); return json({ error: 'workout_not_found' }, 404); }
      return json({ workouts: [], next_cursor: null });
    }));
    const run = sync.run(); await started.promise; store.remove(w.id);
    gate.resolve(json({ workout_id: 1, updated_at: newer, created: false, new_exercises: [] })); await run;
    assert.equal(store.rows().length, 0);
  } finally { db.close(); }
});

test('sync: 409 and remote edit deletion keep local changes, require explicit server reload; failed reload keeps conflict', async () => {
  const { db, store } = setup();
  try {
    for (const status of [409, 404]) {
      store.merge([remoteWorkout(wire())]); const w = store.load().workouts[0]; store.save({ ...toDraft(w), notes: 'local' });
      let failReload = false, deleted = false, puts = 0;
      const { sync } = runner(store, fake((_url, init) => {
        if (init.method === 'PUT') { puts++; return json({ error: status === 409 ? 'conflict' : 'workout_not_found' }, status); }
        if (failReload) throw new Error('offline');
        return json({ workouts: deleted ? [] : [{ ...wire(), note: 'remote', updated_at: newer }], next_cursor: null });
      }));
      await sync.run(); await sync.run(); assert.equal(puts, 1);
      assert.equal(store.load().workouts[0].notes, 'local'); assert.equal(store.rows()[0].pending, true); assert.ok(store.rows()[0].error);
      failReload = true; await sync.resolve(w.id); assert.equal(store.load().workouts[0].notes, 'local');
      failReload = false; deleted = status === 404; await sync.resolve(w.id);
      if (deleted) assert.equal(store.rows().length, 0);
      else { assert.equal(store.load().workouts[0].notes, 'remote'); assert.equal(store.rows()[0].pending, false); }
    }
  } finally { db.close(); }
});

test('sync: failed full history never clears cache; fetched records preserve pending edits and active draft base revision', async () => {
  const { db, store } = setup();
  try {
    store.merge([remoteWorkout(wire())]); const w = store.load().workouts[0];
    store.writeDraft({ ...toDraft(w), notes: 'draft' });
    store.merge([{ ...remoteWorkout(wire()), revision: newer, notes: 'remote' }]);
    assert.equal(store.load().workouts[0].revision, revision); assert.equal(store.load().draft?.notes, 'draft');
    const { sync, errors } = runner(store, fake(url => {
      if (url.includes('before=')) throw new Error('offline');
      return json({ workouts: [wire(2)], next_cursor: 'next' });
    }));
    await sync.run(); assert.deepEqual(errors, ['network']); assert.equal(store.load().workouts.length, 1);
    store.save(store.load().draft!);
    store.merge([remoteWorkout(wire())]); assert.equal(store.load().workouts[0].notes, 'draft');
  } finally { db.close(); }
});

test('sync: revoked/expired sessions retain cache/outbox; logout invalidates late ack and account/token changes serialize requests', async () => {
  const { db, connection, store } = setup();
  try {
    const d = fixture(); store.save(d);
    const revoked = runner(store, fake(() => json({ error: 'unauthorized' }, 401)));
    await revoked.sync.run(); assert.deepEqual(revoked.errors, ['unauthorized']); assert.equal(store.rows()[0].pending, true);
    const expired = runner(store, fake(() => { throw new Error('must not fetch'); }), { ...session, expiresAt: revision });
    await expired.sync.run(); assert.deepEqual(expired.errors, ['unauthorized']);
    const gate = deferred<Response>(), started = deferred<void>();
    const old = runner(store, fake((_url, init) => { if (init.method === 'POST') { started.resolve(); return gate.promise; } throw new Error('stale history'); }));
    const run = old.sync.run(); await started.promise;
    old.sync.activate(null);
    const other = createAccountStore(connection, accountKey({ ...session, userId: 2 })); other.save(fixture());
    let otherCalls = 0;
    old.sync.activate({ session: { ...session, userId: 2, token: 'new-token' }, store: other, api: createApi(base, fake((_url, init) => {
      otherCalls++;
      if (init.method === 'POST') return json({ workout_id: 10, updated_at: revision, created: true, new_exercises: [] });
      return json({ workouts: [], next_cursor: null });
    })) });
    assert.equal(otherCalls, 0);
    gate.resolve(json({ workout_id: 9, updated_at: revision, created: true, new_exercises: [] })); await run;
    assert.equal(store.rows()[0].pending, true); assert.equal(store.rows()[0].workout.remoteId, undefined);
    assert.equal(otherCalls, 2);
  } finally { db.close(); }
});

test('auth: native login nonce/session use vault, restored nonce polls; logout clears native state even if revocation fails', async () => {
  const secure = vault(); const calls: string[] = [];
  const api = createApi(base, fake((url, init) => {
    calls.push(url);
    if (url.endsWith('/login')) { assert.equal(init.body, undefined); return json({ bot_url: 'https://t.me/fake_bot?start=login_token', nonce: 'client-only-nonce', expires_at: session.expiresAt }); }
    if (url.endsWith('/poll')) { assert.deepEqual(JSON.parse(init.body as string), { nonce: 'client-only-nonce' }); return json({ status: 'confirmed', user_id: 1, session_token: session.token, expires_at: session.expiresAt }); }
    return json({ error: 'internal' }, 500);
  }));
  const auth = createAuth(base, api, secure); const started = await auth.start();
  assert.equal(started!.bot_url.includes(started!.nonce), false); assert.ok(secure.data.has(LOGIN_KEY));
  const restored = createAuth(base, api, secure); assert.ok((await restored.restore()).login);
  assert.deepEqual(await restored.poll(), session); assert.equal(secure.data.has(LOGIN_KEY), false);
  assert.deepEqual((await createAuth(base,api,secure).restore()).session, session);
  assert.equal((await createAuth('https://other.invalid/api',api,secure).restore()).session, null);
  await assert.rejects(restored.logout(session), /request_failed/);
  assert.equal(secure.data.size, 0); assert.ok(calls.some(c => c.endsWith('/auth/logout')));
});

test('auth: cancellation/expiry and serialized poll prevent a late confirmed session from signing in', async () => {
  const secure = vault(); const gate = deferred<Response>(), started = deferred<void>(); let polls = 0;
  const api = createApi(base, fake(url => {
    if (url.endsWith('/login')) return json({ bot_url: 'https://t.me/fake_bot?start=x', nonce: 'nonce', expires_at: session.expiresAt });
    polls++; started.resolve(); return gate.promise;
  }));
  const auth = createAuth(base,api,secure); await auth.start();
  const poll = auth.poll(); await started.promise; assert.equal(await auth.poll(), null);
  await auth.cancel(); gate.resolve(json({ status: 'confirmed', user_id: 1, session_token: session.token, expires_at: session.expiresAt }));
  assert.equal(await poll, null); assert.equal(polls, 1); assert.equal(secure.data.size, 0);
  const expired = createAuth(base, createApi(base, fake(() => json({ bot_url: 'https://t.me/fake_bot?start=x', nonce: 'n', expires_at: revision }))), secure);
  await expired.start(); await assert.rejects(expired.poll(), /login_expired/); assert.equal(secure.data.has(LOGIN_KEY), false);
});

test('storage: importing a draft editing a legacy workout preserves their identity relationship', () => {
  const { db, connection, store } = setup();
  try {
    const legacy = createStore(connection), d = { ...fixture(), title: 'Legacy name' };
    legacy.save(d); legacy.writeDraft({ ...d, notes: 'unfinished edit' });
    store.importLegacy(randomUUID);
    const data = store.load(); assert.equal(data.draft?.id, data.workouts[0].id);
    store.save(data.draft!); assert.equal(store.rows().length, 1);
    assert.equal(store.load().workouts[0].notes, 'Legacy name\nunfinished edit');
  } finally { db.close(); }
});

test('sync: conflict reload cannot discard a newer saved edit or an active draft changed during the request', async () => {
  const { db, store } = setup();
  try {
    store.merge([remoteWorkout(wire())]); const w = store.load().workouts[0];
    store.save({ ...toDraft(w), notes: 'local' });
    const row = store.rows()[0]; store.failure(row, 'conflict');
    for (const save of [false, true]) {
      const gate = deferred<Response>(), started = deferred<void>();
      const { sync, errors } = runner(store, fake(() => { started.resolve(); return gate.promise; }));
      const resolving = sync.resolve(w.id); await started.promise;
      if (save) store.save({ ...toDraft(w), notes: 'newer save' });
      else store.writeDraft({ ...toDraft(w), notes: 'newer draft' });
      gate.resolve(json({ workouts: [{ ...wire(), note: 'remote' }], next_cursor: null })); await resolving;
      assert.equal(errors.at(-1), 'conflict');
      if (save) assert.equal(store.load().workouts[0].notes, 'newer save');
      else assert.equal(store.load().draft?.notes, 'newer draft');
    }
  } finally { db.close(); }
});

test('sync: conflict resolution waiting for an old request cannot resolve the newly active account', async () => {
  const { db, connection, store } = setup();
  try {
    store.save(fixture()); const id = store.rows()[0].workout.id;
    const gate = deferred<Response>(), started = deferred<void>();
    const { sync } = runner(store, fake(() => { started.resolve(); return gate.promise; }));
    const running = sync.run(); await started.promise;
    const resolving = sync.resolve(id);
    let newRequests = 0;
    const next = createAccountStore(connection, accountKey({ ...session, userId: 2 }));
    sync.activate({ session: { ...session, userId: 2 }, store: next, api: createApi(base, fake(() => { newRequests++; return json({ workouts: [], next_cursor: null }); })) });
    gate.resolve(json({ workout_id: 1, updated_at: revision, created: true, new_exercises: [] }));
    await running; await resolving;
    assert.equal(newRequests, 1); // Normal activation sync only; no old-account conflict fetch.
    assert.equal(store.rows()[0].pending, true);
  } finally { db.close(); }
});

test('auth: pending poll stays pending; cancellation during a vault write restores the previous session', async () => {
  const secure = vault(), gate = deferred<void>(), started = deferred<void>();
  secure.data.set(SESSION_KEY, JSON.stringify(session));
  const writeSession = secure.set;
  const delayedVault = { ...secure, async set(key: string, value: string) {
    if (key === SESSION_KEY && value.includes('new-token')) { started.resolve(); await gate.promise; }
    await writeSession(key,value);
  } };
  let confirmed = false;
  const auth = createAuth(base, createApi(base, fake(url => {
    if (url.endsWith('/login')) return json({ bot_url: 'https://t.me/fake_bot?start=x', nonce: 'n', expires_at: session.expiresAt });
    return json(confirmed ? { status: 'confirmed', user_id: 2, session_token: 'new-token', expires_at: session.expiresAt } : { status: 'pending' });
  })), delayedVault);
  await auth.start(); assert.equal(await auth.poll(), null); assert.ok(secure.data.has(LOGIN_KEY));
  confirmed = true; const poll = auth.poll(); await started.promise;
  const cancel = auth.cancel(); gate.resolve(); await cancel;
  assert.equal(await poll, null); assert.deepEqual(JSON.parse(secure.data.get(SESSION_KEY)!), session);
});

test('storage/sync: restart preserves an uncertain create deletion and completes idempotent create then delete', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'djym-outbox-'));
  const file = join(directory, 'cache.db'); let db = new DatabaseSync(file);
  try {
    let store = createAccountStore(adapter(db), accountKey(session));
    const d = fixture(); store.save(d); store.submitted(d.id); store.remove(d.id); store.writeDraft(fixture());
    db.close(); db = new DatabaseSync(file);
    store = createAccountStore(adapter(db), accountKey(session));
    assert.equal(store.rows()[0].deleted, true); assert.equal(store.rows()[0].submitted, true); assert.ok(store.load().draft);
    const methods: string[] = [];
    const { sync } = runner(store, fake((_url, init) => {
      methods.push(init.method!);
      if (init.method === 'POST') { assert.equal(JSON.parse(init.body as string).source_ref, d.id); return json({ workout_id: 7, updated_at: revision, created: false, new_exercises: [] }); }
      if (init.method === 'DELETE') return json(null,204);
      return json({ workouts: [], next_cursor: null });
    }));
    await sync.run(); assert.deepEqual(methods, ['POST','DELETE','GET']); assert.equal(store.rows().length, 0); assert.ok(store.load().draft);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('sync: concurrent confirmed reloads share the sequence gate and do not discard edits made while waiting', async () => {
  const { db, store } = setup();
  try {
    store.merge([remoteWorkout(wire())]); const w = store.load().workouts[0];
    store.save({ ...toDraft(w), notes: 'local' }); store.failure(store.rows()[0], 'conflict');
    const gate = deferred<Response>(), started = deferred<void>(); let requests = 0;
    const { sync, errors } = runner(store, fake(() => { requests++; started.resolve(); return gate.promise; }));
    const first = sync.resolve(w.id); await started.promise;
    const second = sync.resolve(w.id);
    store.save({ ...toDraft(w), notes: 'new edit while waiting' });
    gate.resolve(json({ workouts: [wire()], next_cursor: null })); await first; await second;
    assert.equal(requests, 1); assert.equal(store.load().workouts[0].notes, 'new edit while waiting');
    assert.deepEqual(errors, ['conflict','conflict']);
  } finally { db.close(); }
});

for (const prior of [null, session]) test(`auth: cancellation during final login removal restores ${prior ? 'prior session' : 'session absence'}`, async () => {
  const secure = vault(), gate = deferred<void>(), started = deferred<void>();
  if (prior) secure.data.set(SESSION_KEY, JSON.stringify(prior));
  let delayed = false;
  const delayedVault = { ...secure, async remove(key: string) {
    if (key === LOGIN_KEY && !delayed) { delayed = true; started.resolve(); await gate.promise; }
    await secure.remove(key);
  } };
  const api = createApi(base, fake(url => json(url.endsWith('/login')
    ? { bot_url: 'https://t.me/fake_bot?start=x', nonce: 'n', expires_at: session.expiresAt }
    : { status: 'confirmed', user_id: 2, session_token: 'new-token', expires_at: session.expiresAt })));
  const auth = createAuth(base, api, delayedVault); await auth.start();
  const poll = auth.poll(); await started.promise;
  const cancel = auth.cancel(); gate.resolve(); await cancel;
  assert.equal(await poll, null); assert.equal(secure.data.has(LOGIN_KEY), false);
  assert.deepEqual((await createAuth(base, api, secure).restore()).session, prior);
});

test('auth: malformed stored session or login JSON returns typed invalid_response without deleting data', async () => {
  const api = createApi(base, fake(() => { throw new Error('must not fetch'); }));
  for (const key of [SESSION_KEY, LOGIN_KEY]) {
    const secure = vault(); secure.data.set(key, '{broken');
    await assert.rejects(createAuth(base, api, secure).restore(), e => e instanceof ApiError && e.code === 'invalid_response');
    assert.equal(secure.data.get(key), '{broken');
  }
});

test('sync: unknown-ID POST conflict preserves newer local generations durably and explicit source-ref reload resolves', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'djym-create-conflict-'));
  const file = join(directory, 'cache.db'); let db = new DatabaseSync(file);
  try {
    let store = createAccountStore(adapter(db), accountKey(session));
    const d = fixture(); store.save(d);
    await runner(store, fake(() => { throw new Error('lost create response'); })).sync.run();
    assert.equal(store.rows()[0].submitted, true); assert.equal(store.rows()[0].workout.remoteId, undefined);
    store.save({ ...d, notes: 'edit after uncertain create' });
    const gate = deferred<Response>(), started = deferred<void>(); let posts = 0;
    const server = { ...wire(9, 'mobile', d.id), note: 'second device', updated_at: newer };
    const { sync } = runner(store, fake((_url, init) => {
      if (init.method === 'POST') {
        posts++; assert.equal(JSON.parse(init.body as string).note, 'edit after uncertain create');
        started.resolve(); return gate.promise;
      }
      return json({ workouts: [server], next_cursor: null });
    }));
    const running = sync.run(); await started.promise;
    store.save({ ...d, notes: 'even newer local generation' });
    const generation = store.rows()[0].generation;
    gate.resolve(json({ error: 'conflict' }, 409)); await running; await sync.run();
    assert.equal(posts, 1); assert.equal(store.rows().length, 1);
    assert.equal(store.rows()[0].error, 'conflict'); assert.equal(store.rows()[0].pending, true);
    assert.equal(store.rows()[0].generation, generation); assert.equal(store.rows()[0].workout.notes, 'even newer local generation');
    db.close(); db = new DatabaseSync(file); store = createAccountStore(adapter(db), accountKey(session));
    assert.equal(store.rows()[0].error, 'conflict'); assert.equal(store.rows()[0].pending, true);
    assert.equal(store.rows()[0].workout.notes, 'even newer local generation');
    // Exercise explicit resolution while the remote ID is still unknown, matching UUID instead.
    const unknown = fixture(); store.save(unknown); store.submitted(unknown.id);
    const unknownRunner = runner(store, fake((_url, init) => init.method === 'POST'
      ? json({ error: 'conflict' }, 409) : json({ workouts: [], next_cursor: null })));
    await unknownRunner.sync.run(); assert.equal(store.rows().find(r => r.workout.id === unknown.id)?.workout.remoteId, undefined);
    const restored = runner(store, fake(() => json({ workouts: [server, { ...wire(10, 'mobile', unknown.id), note: 'server reload' }], next_cursor: null })));
    await restored.sync.resolve(unknown.id);
    const resolved = store.rows().find(r => r.workout.id === unknown.id)!;
    assert.equal(resolved.pending, false); assert.equal(resolved.error, ''); assert.equal(resolved.workout.remoteId, 10); assert.equal(resolved.workout.notes, 'server reload');
    await restored.sync.resolve(d.id);
    assert.equal(store.rows().find(r => r.workout.id === d.id)?.pending, false);
    assert.equal(store.rows().find(r => r.workout.id === d.id)?.workout.notes, 'second device');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('sync: late create ACK leaves newer generation pending through a revisioned PUT conflict', async () => {
  const { db, connection, store } = setup();
  try {
    const d = fixture(); store.save(d);
    const gate = deferred<Response>(), started = deferred<void>();
    const { sync } = runner(store, fake((_url, init) => {
      if (init.method === 'POST') { started.resolve(); return gate.promise; }
      if (init.method === 'PUT') return json({ error: 'conflict' }, 409);
      return json({ workouts: [{ ...wire(9, 'mobile', d.id), note: 'second device', updated_at: newer }], next_cursor: null });
    }));
    const running = sync.run(); await started.promise; store.save({ ...d, notes: 'newer local edit' });
    gate.resolve(json({ workout_id: 9, updated_at: revision, created: true, new_exercises: [] })); await running;
    const reopened = createAccountStore(connection, accountKey(session));
    assert.equal(reopened.rows()[0].pending, true); assert.equal(reopened.rows()[0].error, 'conflict');
    assert.equal(reopened.rows()[0].generation, 2); assert.equal(reopened.rows()[0].workout.notes, 'newer local edit');
  } finally { db.close(); }
});
