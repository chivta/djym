import { request, allWorkouts, HTTPError } from "./api.js";
import {
  activeAccount,
  readAccount,
  mutate,
  openDB,
  queueRecord,
} from "./db.js";
import { uuid, workoutPayload, fromServer, sameWorkout } from "./domain.js";

const LEASE_MS = 60000;
// Web Locks release on tab death. The transactional fallback renews a durable
// lease. Expired senders can only acknowledge their own immutable attempt; a
// successor marks abandoned attempts uncertain, never dispatches them again.
async function leased(fn) {
  if (navigator.locks)
    return navigator.locks.request(
      "djym-sender",
      { ifAvailable: true },
      (lock) => (lock ? fn() : false),
    );
  const db = await openDB(),
    owner = uuid();
  // Initiate fetch synchronously while holding a read transaction on the lease.
  // A resumed expired tab must not dispatch after its successor took ownership.
  const dispatch = (send) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction("meta"),
        r = tx.objectStore("meta").get("sender");
      r.onsuccess = () => {
        if (r.result?.owner !== owner || r.result.until <= Date.now()) {
          reject(
            new Error(
              "Sync lease expired before dispatch. The attempt is retained for review.",
            ),
          );
          return;
        }
        resolve(send());
      };
      r.onerror = () => reject(r.error);
    });
  const claim = () =>
    new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite"),
        store = tx.objectStore("meta"),
        r = store.get("sender");
      let won = false;
      r.onsuccess = () => {
        if (
          !r.result ||
          r.result.until < Date.now() ||
          r.result.owner === owner
        ) {
          store.put({ owner, until: Date.now() + LEASE_MS }, "sender");
          won = true;
        }
      };
      tx.oncomplete = () => resolve(won);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  if (!(await claim())) return false;
  let lost = false;
  const timer = setInterval(
    () =>
      claim()
        .then((ok) => {
          if (!ok) lost = true;
        })
        .catch(() => {
          lost = true;
        }),
    10000,
  );
  try {
    return await fn(() => !lost, dispatch);
  } finally {
    clearInterval(timer);
    await new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite"),
        s = tx.objectStore("meta"),
        r = s.get("sender");
      r.onsuccess = () => {
        if (r.result?.owner === owner) s.delete("sender");
      };
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
}
function acknowledge(state, id, attempt, result) {
  const item = state.outbox[id];
  if (item?.attempt !== attempt.attempt) return;
  const collection = item.kind === "program" ? state.programs : state.records,
    record = collection.find((r) => r.id === id);
  delete state.outbox[id];
  if (!record) return;
  if (item.operation === "delete") {
    if (record.version !== item.version) {
      // A different tab may have saved an edit while DELETE was in flight.
      // Keep that content, but never silently recreate a deleted server record.
      delete record.serverID;
      delete record.revision;
      delete record.remote;
      record.deleted = false;
      record.localOnly = true;
      record.syncNote =
        "Deleted on the server while a newer edit was saved. That edit is preserved locally; edit/save explicitly to create it again.";
    } else state.records = state.records.filter((r) => r.id !== id);
    return;
  }
  if (item.kind === "program") record.revision = result.updated_at;
  else {
    record.serverID = result.workout_id;
    record.revision = result.updated_at;
    record.localOnly = false;
  }
  if (record.version !== item.version || record.deleted) {
    if (item.kind === "workout") queueRecord(state, record);
    else
      state.outbox[id] = {
        kind: "program",
        operation: "update",
        status: "queued",
        version: record.version,
      };
  }
}
export async function refresh(account, rows, programs) {
  await mutate(account, (state) => {
    for (const item of Object.values(state.outbox))
      if (item.status === "sending") item.status = "uncertain";
    for (const record of [...state.records]) {
      const item = state.outbox[record.id];
      if (item?.status === "uncertain") {
        if (item.operation === "create" && item.kind === "workout") {
          const matches = rows.filter(
            (r) =>
              r.source === "mobile" && r.source_ref === item.payload.source_ref,
          );
          if (matches.length === 1) {
            acknowledge(state, record.id, item, {
              workout_id: matches[0].id,
              updated_at: matches[0].updated_at,
            });
          } else if (matches.length > 1) {
            item.status = "conflict";
            item.error =
              "Multiple server workouts share this source reference. Review server history; nothing was discarded.";
          }
        } else if (item.kind === "workout") {
          const row = rows.find((r) => r.id === item.serverID);
          if (
            (item.operation === "delete" && !row) ||
            (item.operation === "update" &&
              row &&
              sameWorkout(row, item.payload))
          )
            acknowledge(state, record.id, item, {
              workout_id: item.serverID,
              updated_at: row?.updated_at,
            });
          else
            item.error =
              "Uncertain write differs from server history. Review/export before explicitly retrying. A later remote edit may have replaced it.";
        }
      }
    }
    for (const program of state.programs) {
      const item = state.outbox[program.id];
      if (item?.status !== "uncertain") continue;
      const remote = programs.find((p) => p.id === program.id);
      if (
        remote &&
        remote.name === item.payload.name &&
        JSON.stringify(remote.entries) === JSON.stringify(item.payload.entries)
      )
        acknowledge(state, program.id, item, remote);
      else if (item.operation === "create") {
        item.status = "queued";
      } // UUID program POST is replay-safe.
      else {
        item.status = "conflict";
        item.error = "Program changed remotely; review before replacing.";
      }
    }
    for (const row of rows) {
      const record = state.records.find((r) => r.serverID === row.id);
      if (!record) {
        state.records.push(fromServer(row));
        continue;
      }
      if (state.outbox[record.id] || record.localOnly) {
        record.remote = row;
        continue;
      }
      Object.assign(record, fromServer(row), {
        id: record.id,
        version: record.version,
      });
    }
    // The full paginated snapshot is required before inferring deletion.
    state.records = state.records.filter(
      (r) =>
        !r.serverID ||
        r.localOnly ||
        state.outbox[r.id] ||
        state.edit?.targetId === r.id ||
        rows.some((row) => row.id === r.serverID),
    );
    for (const p of programs) {
      const local = state.programs.find((r) => r.id === p.id);
      if (!local)
        state.programs.push({ ...p, revision: p.updated_at, version: 1 });
      else if (state.outbox[p.id]) local.remote = p;
      else Object.assign(local, p, { revision: p.updated_at });
    }
    state.programs = state.programs.filter(
      (p) =>
        !p.revision ||
        state.outbox[p.id] ||
        programs.some((r) => r.id === p.id),
    );
    state.lastSync = new Date().toISOString();
  });
}
export async function recoverAccount(account) {
  return leased(() =>
    mutate(account, (state) => {
      for (const item of Object.values(state.outbox))
        if (item.status === "sending") item.status = "uncertain";
    }),
  );
}
export async function syncAccount(account) {
  if (account === "guest" || !navigator.onLine) return false;
  return leased(
    async (stillOwner = () => true, dispatch = (send) => send()) => {
      const authenticated = await request("/auth/me");
      if (
        String(authenticated.user_id) !== account ||
        (await activeAccount()) !== account
      )
        throw new Error("Account changed. Sign in again before syncing.");
      const rows = await allWorkouts(account),
        response = await request(`/v1/users/${account}/programs`);
      if (!stillOwner()) return false;
      await refresh(account, rows, response.programs || []);
      const snapshot = await readAccount(account);
      for (const id of Object.keys(snapshot.outbox)) {
        if (!stillOwner() || (await activeAccount()) !== account) break;
        const me = await request("/auth/me");
        if (String(me.user_id) !== account)
          throw new Error("Session changed; sync stopped.");
        let attempt;
        await mutate(account, (state) => {
          const item = state.outbox[id];
          if (item?.status !== "queued") return;
          const record = (
            item.kind === "program" ? state.programs : state.records
          ).find((r) => r.id === id);
          if (!record) {
            delete state.outbox[id];
            return;
          }
          const remoteRevision = record.remote?.updated_at;
          if (
            item.operation !== "create" &&
            remoteRevision &&
            remoteRevision !== record.revision
          ) {
            item.status = "conflict";
            item.error =
              "Known remote change. Workout replacements are last-write-wins, not atomic conflict protected.";
            return;
          }
          try {
            let payload;
            if (item.kind === "program")
              payload = {
                name: record.name,
                entries: record.entries,
                ...(item.operation === "create"
                  ? { id: record.id }
                  : { expected_updated_at: record.revision }),
              };
            else if (item.operation === "delete") payload = {};
            else {
              payload = workoutPayload(record, record.date);
              // Keep server-only optional content when editing downloaded records.
              for (const key of ["type", "kcal", "protein_g", "note"])
                if (record.remote?.[key] != null)
                  payload[key] = record.remote[key];
              if (item.operation === "create") {
                record.sourceRef = record.sourceRef || uuid();
                payload.source = "mobile";
                payload.source_ref = record.sourceRef;
              }
            }
            Object.assign(item, {
              status: "sending",
              attempt: uuid(),
              payload,
              serverID: record.serverID,
              version: record.version,
              error: "",
            });
            attempt = structuredClone(item);
          } catch (error) {
            item.status = "blocked";
            item.error = error.message;
          }
        });
        if (!attempt) continue;
        const base = `/v1/users/${account}/${attempt.kind === "program" ? "programs" : "workouts"}`;
        const path =
          attempt.operation === "create"
            ? base
            : base + "/" + (attempt.kind === "program" ? id : attempt.serverID);
        try {
          const result = await dispatch(() =>
            request(
              path,
              attempt.operation === "create"
                ? "POST"
                : attempt.operation === "update"
                  ? "PUT"
                  : "DELETE",
              attempt.payload,
            ),
          );
          await mutate(account, (state) =>
            acknowledge(state, id, attempt, result),
          );
        } catch (error) {
          await mutate(account, (state) => {
            const item = state.outbox[id];
            if (item?.attempt !== attempt.attempt) return;
            item.error = error.message;
            if (error instanceof HTTPError && error.status < 500) {
              item.status = [401, 403, 429].includes(error.status)
                ? "queued"
                : error.status === 409
                  ? "conflict"
                  : "blocked";
            } else
              item.status =
                attempt.kind === "program" && attempt.operation === "create"
                  ? "queued"
                  : "uncertain";
          });
          if (
            !(error instanceof HTTPError) ||
            [401, 403, 429].includes(error.status) ||
            error.status >= 500
          )
            throw error;
        }
      }
      return true;
    },
  );
}
export async function resolveRecord(account, id, keepLocal = false) {
  return mutate(
    account,
    (state) => {
      const record = state.records.find((r) => r.id === id),
        item = state.outbox[id];
      if (!record || !item) return;
      if (item.status === "sending")
        throw new Error("Sync is in flight. Wait before resolving.");
      if (keepLocal) {
        delete state.outbox[id];
        record.localOnly = true;
        record.deleted = false;
        return;
      }
      if (
        item.operation === "create" &&
        ["uncertain", "conflict"].includes(item.status)
      )
        record.sourceRef = uuid();
      if (record.remote) record.revision = record.remote.updated_at;
      delete state.outbox[id];
      queueRecord(state, record);
    },
    true,
  );
}
