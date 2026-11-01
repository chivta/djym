import { emptyState, uuid, normalizeTitle } from "./domain.js";
const DB_NAME = "djym-v1";
const LEGACY_KEY = "fieldnotes-prototype-v1";
let connection;
export const changes =
  typeof BroadcastChannel === "function"
    ? new BroadcastChannel("djym-state")
    : null;
export function openDB() {
  if (!connection)
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("accounts");
        request.result.createObjectStore("meta");
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("Close older djym tabs to open device storage."));
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          connection = null;
        };
        resolve(request.result);
      };
    });
  return connection;
}
// Never silently downgrade a pre-dispatch attempt (or any app write) to the
// browser's default/relaxed flush policy. Unsupported engines stay read-only.
export function strictWriteTransaction(db, stores) {
  let tx;
  try {
    tx = db.transaction(stores, "readwrite", { durability: "strict" });
    if (tx.durability === "strict") return tx;
  } catch {
    throw new Error(
      "Strict IndexedDB durability is unavailable. Writes and automatic sync are disabled; existing data can still be exported.",
    );
  }
  tx.abort();
  throw new Error(
    "Strict IndexedDB durability is unavailable. Writes and automatic sync are disabled; existing data can still be exported.",
  );
}
// Mutators are synchronous inside a single read/write transaction; every tab reads
// current state before modifying it. Resolve only after strict transaction completion.
export async function transaction(stores, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = strictWriteTransaction(db, stores),
      values = {},
      requests = [];
    let result, error;
    tx.oncomplete = () => {
      changes?.postMessage("changed");
      resolve(result);
    };
    tx.onerror = tx.onabort = () =>
      reject(
        error || tx.error || new Error("Device storage transaction failed."),
      );
    const run = () => {
      if (requests.some((r) => r.readyState !== "done")) return;
      try {
        result = fn(values, tx);
      } catch (err) {
        error = err;
        tx.abort();
      }
    };
    for (const [store, key] of stores.includes("accounts")
      ? [
          ["accounts", "guest"],
          ["meta", "active"],
        ]
      : [["meta", "active"]]) {
      const req = tx.objectStore(store).get(key);
      requests.push(req);
      req.onsuccess = () => {
        values[store + ":" + key] = req.result;
        run();
      };
    }
  });
}
export async function activeAccount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction("meta").objectStore("meta").get("active");
    r.onsuccess = () => resolve(r.result || "guest");
    r.onerror = () => reject(r.error);
  });
}
export async function readAccount(account) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction("accounts").objectStore("accounts").get(account);
    r.onsuccess = () => resolve(r.result || emptyState());
    r.onerror = () => reject(r.error);
  });
}
export async function mutate(account, fn, requireActive = false) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = strictWriteTransaction(db, ["accounts", "meta"]);
    let state, error;
    tx.oncomplete = () => {
      changes?.postMessage("changed");
      resolve(state);
    };
    tx.onerror = tx.onabort = () =>
      reject(
        error || tx.error || new Error("Device storage transaction failed."),
      );
    const active = tx.objectStore("meta").get("active");
    active.onsuccess = () => {
      if (requireActive && (active.result || "guest") !== account) {
        error = new Error(
          "Account changed in another tab. Your action was not applied.",
        );
        tx.abort();
        return;
      }
      const request = tx.objectStore("accounts").get(account);
      request.onsuccess = () => {
        try {
          state = request.result || emptyState();
          fn(state);
          tx.objectStore("accounts").put(state, account);
        } catch (err) {
          error = err;
          tx.abort();
        }
      };
    };
  });
}
export async function setActive(account) {
  await mutate(account, () => {});
  await transaction(["meta"], (_, tx) =>
    tx.objectStore("meta").put(account, "active"),
  );
}
export function queueRecord(state, record) {
  const old = state.outbox[record.id];
  // In-flight/ambiguous attempts are immutable. New content stays on the record
  // until reconciliation/acknowledgement can schedule the next version safely.
  if (old && ["sending", "uncertain", "conflict"].includes(old.status)) return;
  state.outbox[record.id] = {
    kind: "workout",
    status: "queued",
    operation: record.serverID
      ? record.deleted
        ? "delete"
        : "update"
      : "create",
    version: record.version,
  };
}
export async function adoptGuest(account) {
  if (account === "guest") return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = strictWriteTransaction(db, ["accounts", "meta"]);
    let error;
    tx.oncomplete = () => {
      changes?.postMessage("changed");
      resolve();
    };
    tx.onerror = tx.onabort = () => reject(error || tx.error);
    const active = tx.objectStore("meta").get("active");
    active.onsuccess = () => {
      if (active.result !== account) {
        error = new Error("Account changed.");
        tx.abort();
        return;
      }
      const store = tx.objectStore("accounts"),
        guest = store.get("guest");
      guest.onsuccess = () => {
        const req = store.get(account);
        req.onsuccess = () => {
          const source = guest.result || emptyState(),
            target = req.result || emptyState();
          for (const record of source.records) {
            if (!record.deleted) {
              target.records.push(record);
              queueRecord(target, record);
            }
          }
          for (const program of source.programs) {
            target.programs.push(program);
            target.outbox[program.id] = {
              kind: "program",
              status: "queued",
              operation: "create",
              version: program.version || 1,
            };
          }
          source.records = [];
          source.programs = [];
          source.outbox = {};
          store.put(source, "guest");
          store.put(target, account);
        };
      };
    };
  });
}
export function importedState(saved, legacy = false) {
  if (
    !saved ||
    !Array.isArray(saved.records) ||
    !(
      saved.draft === null ||
      (saved.draft && typeof saved.draft.text === "string")
    ) ||
    saved.records.some(
      (r) => !r || typeof r.text !== "string" || typeof r.date !== "string",
    ) ||
    (saved.programs !== undefined && !Array.isArray(saved.programs))
  )
    throw new Error("Invalid backup. Original data was not changed.");
  const state = emptyState(),
    idMap = new Map();
  state.draft = saved.draft;
  state.records = saved.records
    .filter((r) => !r.sample && !String(r.id).startsWith("sample-"))
    .map((r) => {
      const id = uuid();
      idMap.set(r.id, id);
      return {
        id,
        text: r.text,
        date: r.date,
        startedAt: typeof r.startedAt === "string" ? r.startedAt : "",
        completedAt: typeof r.completedAt === "string" ? r.completedAt : "",
        version: 1,
        localOnly: true,
      };
    });
  state.programs = (saved.programs || []).map((p) => {
    let entries;
    if (legacy) {
      if (
        !Array.isArray(p.exercises) ||
        !Array.isArray(p.targets) ||
        p.exercises.length !== p.targets.length
      )
        throw new Error("Invalid legacy programs.");
      entries = p.exercises.map((name, i) => ({
        name,
        set_count: p.targets[i].sets,
        target_reps_min: p.targets[i].min,
        target_reps_max: p.targets[i].max,
      }));
    } else entries = p.entries;
    if (typeof p.name !== "string" || !Array.isArray(entries))
      throw new Error("Invalid backup program.");
    if (
      !p.name.trim() ||
      [...p.name].length > 2000 ||
      !entries.length ||
      entries.length > 100
    )
      throw new Error("Invalid program name or size.");
    const validated = entries.map((e) => {
      if (
        typeof e.name !== "string" ||
        !e.name.trim() ||
        [...e.name].length > 2000 ||
        !Number.isInteger(e.set_count) ||
        e.set_count < 1 ||
        e.set_count > 100
      )
        throw new Error("Invalid program entry.");
      const min = e.target_reps_min ?? null,
        max = e.target_reps_max ?? null,
        target = e.target_reps ?? null;
      if (
        (min === null) !== (max === null) ||
        (min !== null &&
          (target !== null ||
            !Number.isInteger(min) ||
            !Number.isInteger(max) ||
            min < 1 ||
            min > max ||
            max > 9999)) ||
        (target !== null &&
          (!Number.isInteger(target) || target < 1 || target > 9999))
      )
        throw new Error("Invalid program targets.");
      return {
        name: e.name,
        set_count: e.set_count,
        target_reps: target,
        target_reps_min: min,
        target_reps_max: max,
      };
    });
    return {
      name: p.name,
      entries: validated,
      id: uuid(),
      version: 1,
      localOnly: true,
    };
  });
  if (saved.edit) {
    if (
      !idMap.has(saved.edit.targetId) ||
      typeof saved.edit.draft?.text !== "string"
    )
      throw new Error("Invalid saved edit.");
    state.edit = {
      targetId: idMap.get(saved.edit.targetId),
      draft: saved.edit.draft,
    };
  }
  return state;
}
export async function migrateLegacy() {
  // The raw key is never rewritten, including when parsing or committing fails.
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  const db = await openDB();
  const done = await new Promise((resolve, reject) => {
    const r = db.transaction("meta").objectStore("meta").get("legacyImported");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (done) return;
  const imported = importedState(JSON.parse(raw), true);
  await transaction(["accounts", "meta"], (values, tx) => {
    // Serialize the marker read with the import itself (another tab may race).
    const marker = tx.objectStore("meta").get("legacyImported");
    marker.onsuccess = () => {
      if (marker.result) return;
      const guest = values["accounts:guest"] || emptyState();
      guest.records.push(...imported.records);
      guest.programs.push(...imported.programs);
      if (!guest.draft?.text.trim() || !values["accounts:guest"])
        guest.draft = imported.draft;
      if (imported.edit && !guest.edit) guest.edit = imported.edit;
      tx.objectStore("accounts").put(guest, "guest");
      tx.objectStore("meta").put(
        { raw, at: new Date().toISOString() },
        "legacyImported",
      );
    };
  });
}
export async function importBackup(saved) {
  const restored = importedState(
    saved,
    (saved.programs || []).some((p) => Array.isArray(p.exercises)),
  );
  await mutate("guest", (state) => {
    state.records.push(...restored.records);
    state.programs.push(...restored.programs);
    if (!state.draft?.text.trim()) state.draft = restored.draft;
    if (restored.edit && !state.edit) state.edit = restored.edit;
  });
}
export async function importPrograms(account, days) {
  return mutate(
    account,
    (state) => {
      for (const day of days) {
        const previous = state.programs.find(
          (p) => normalizeTitle(p.name) === normalizeTitle(day.name),
        );
        if (
          previous &&
          ["sending", "uncertain", "conflict"].includes(
            state.outbox[previous.id]?.status,
          )
        )
          throw new Error(
            "A matching program has unresolved sync. Sync or resolve it before reimporting.",
          );
        const program = {
          ...day,
          id: previous?.id || day.id,
          revision: previous?.revision,
          version: (previous?.version || 0) + 1,
        };
        state.programs = state.programs.filter((p) => p.id !== program.id);
        state.programs.push(program);
        if (account !== "guest")
          state.outbox[program.id] = {
            kind: "program",
            status: "queued",
            operation: program.revision ? "update" : "create",
            version: program.version,
          };
      }
    },
    true,
  );
}
