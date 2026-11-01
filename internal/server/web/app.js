import {
  normalize,
  normalizeTitle,
  titleOf,
  workoutDate,
  workoutPayload,
  exerciseLine,
  matchProgram,
  targetText,
  freshDraft,
  uuid,
  emptyState,
} from "./domain.js";
import {
  activeAccount,
  readAccount,
  mutate,
  setActive,
  queueRecord,
  changes,
  migrateLegacy,
  adoptGuest,
  importPrograms,
  importBackup,
} from "./db.js";
import { parseProgram } from "./domain.js";
import { request, HTTPError } from "./api.js";
import { syncAccount, resolveRecord, recoverAccount } from "./sync.js";
const $ = (id) => document.getElementById(id),
  editor = $("editor");
let account = "guest",
  state = emptyState(),
  page = "workout",
  selectedID = null,
  suggestion = null,
  composing = false,
  gesture = null,
  toastTimer,
  pollTimer,
  loginExpiry = 0,
  syncing = false,
  storageOK = false;
let writes = Promise.resolve(),
  syncRequested = false,
  draftSequence = 0,
  committedDraftSequence = 0,
  draftSaveError = false;
function activeDraft() {
  return state.edit ? state.edit.draft : state.draft;
}
function matchedProgram() {
  return matchProgram(state.programs, editor.value);
}
function dateLabel(date) {
  const d = new Date(date + "T12:00:00");
  return Number.isNaN(+d)
    ? date
    : d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}
function announce(text) {
  clearTimeout(toastTimer);
  $("toast").textContent = text;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}
function failure(error) {
  $("storage-notice").textContent = error.message;
  announce(error.message);
}
function act(fn) {
  const result = writes.then(fn);
  writes = result.catch(failure);
  return result;
}
function guard(fn) {
  return (...args) => {
    const partition = account;
    act(async () => {
      if (account !== partition || (await activeAccount()) !== partition)
        throw new Error(
          "Account changed. Review this action in the current account.",
        );
      await fn(...args);
    }).catch(() => {});
  };
}
function storageStatus() {
  $("save-status").textContent = draftSaveError
    ? "Not saved"
    : storageOK
      ? "Draft saved locally"
      : "Saving…";
  $("account-label").textContent =
    account === "guest"
      ? "Guest · local only"
      : `Account ${account} · ${navigator.onLine ? "foreground sync" : "offline"}`;
  $("logout").hidden = account === "guest";
  $("adopt").hidden = account === "guest";
  const pending = Object.values(state.outbox),
    problems = pending.filter((i) =>
      ["blocked", "conflict", "uncertain"].includes(i.status),
    );
  $("sync").textContent = syncing
    ? "Syncing…"
    : `Sync${pending.length ? " · " + pending.length + " pending" : ""}`;
  $("sync").disabled = syncing;
  $("sync-summary").textContent =
    state.programs.length +
    " program days on this device" +
    (problems.length
      ? " · " +
        problems.length +
        " sync items need review. " +
        problems
          .map(
            (i) =>
              i.status +
              ": " +
              (i.error || "Reconcile with Sync; never blindly resent."),
          )
          .join(" ")
      : "");
  $("resolve-programs").hidden = !state.programs.some((p) =>
    ["conflict", "blocked"].includes(state.outbox[p.id]?.status),
  );
}
function previousSets(name) {
  const title = normalizeTitle(titleOf(editor.value));
  if (!title || !name) return null;
  let date;
  try {
    date = workoutDate(editor.value);
  } catch {
    return null;
  }
  const records = state.records
    .filter((r) => !r.deleted)
    .filter(
      (r) =>
        normalizeTitle(titleOf(r.text)) === title && r.date.slice(0, 10) < date,
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const record of records) {
    const line = record.text
      .split("\n")
      .slice(1)
      .map(exerciseLine)
      .find((line) => normalize(line.name) === normalize(name) && line.sets);
    if (line) return { sets: line.sets, record };
  }
  return null;
}
function nextSuggestion() {
  // A plain textarea remains the source of truth. Only suggest at its end so wrapped
  // ghost text can never overlap later lines or disagree with the native caret.
  if (
    !activeDraft() ||
    composing ||
    document.activeElement !== editor ||
    editor.selectionStart !== editor.value.length ||
    editor.selectionEnd !== editor.value.length
  )
    return null;
  const lines = editor.value.split("\n");
  const current = lines[lines.length - 1];
  if (lines.length < 2 || !lines.slice(0, -1).some((line) => line.trim()))
    return null;
  const ctx = exerciseLine(current),
    program = matchedProgram();
  if (ctx.target) return null;
  const used = lines
    .slice(1, -1)
    .map((line) => normalize(exerciseLine(line).name));
  const name = program?.exercises.find(
    (name) =>
      (ctx.sets
        ? normalize(name) === normalize(ctx.name)
        : normalize(name).startsWith(normalize(ctx.name))) &&
      (!used.includes(normalize(name)) ||
        normalize(ctx.name) === normalize(name)),
  );
  // Unknown titles can reuse their own exact exercise history, never another program.
  const history = previousSets(name || ctx.name);
  const target = program?.targets?.[program.exercises.indexOf(name)];
  const suffix = history
    ? " " + history.sets
    : target?.min
      ? " — " + targetText(target)
      : " ";
  let text = "";
  if (name && !ctx.sets) {
    const typed = current.trimStart();
    // Preserve every typed character, including case and whitespace, on acceptance.
    // Non-canonical spacing is valid text; finish the name once it matches exactly.
    if (normalize(typed) === normalize(name)) {
      if (history || target)
        text = /\s$/.test(current) ? suffix.trimStart() : suffix;
    } else if (name.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase())) {
      text = name.slice(typed.length) + suffix;
    }
  } else if (history) {
    if (!ctx.sets) text = (/\s$/.test(current) ? "" : " ") + history.sets;
    else if (history.sets.startsWith(ctx.sets))
      text = history.sets.slice(ctx.sets.length);
  }
  if (!text) return null;
  return {
    text,
    source:
      (history
        ? dateLabel(history.record.date) + " · " + "your history"
        : program.name + " · saved program") +
      (target?.min ? " · target " + targetText(target) : ""),
  };
}
function fitEditor() {
  editor.style.height = "auto";
  editor.style.height =
    Math.max(330, editor.scrollHeight, $("mirror-text").scrollHeight) + "px";
}
function updateSuggestions() {
  suggestion = nextSuggestion();
  $("mirror-prefix").textContent = editor.value;
  $("ghost").textContent = suggestion?.text || "";
  $("accept").hidden = !suggestion;
  $("accept").setAttribute(
    "aria-label",
    suggestion ? "Accept suggestion: " + suggestion.text : "Accept suggestion",
  );
  $("suggestion-help").textContent = suggestion
    ? "Swipe right or Tab to accept"
    : "Date + any title, then one exercise per line.";
  $("suggestion-source").textContent = suggestion?.source || "";
  $("complete").disabled = !activeDraft() || !editor.value.trim();
  fitEditor();
}
function showPage(next) {
  page = next;
  for (const name of ["workout", "history", "detail"])
    $(name + "-page").hidden = name !== next;
  $("history-toggle").textContent = next === "workout" ? "History" : "Workout";
  if (next === "history") renderHistory();
  if (next === "workout") renderDraft();
  if (next === "detail") renderDetail();
  storageStatus();
}
function renderDraft() {
  const draft = activeDraft();
  $("draft-content").hidden = !draft;
  $("empty-draft").hidden = Boolean(draft);
  editor.value = draft?.text || "";
  editor.disabled = !draft;
  editor.setSelectionRange(editor.value.length, editor.value.length);
  $("edit-banner").hidden = !state.edit;
  $("complete").textContent = state.edit ? "Save changes" : "Complete workout";
  $("started-at").value = draft?.startedAt || "";
  $("completed-at").value = draft?.completedAt || "";
  $("workout-times").open = Boolean(draft?.startedAt || draft?.completedAt);
  $("time-error").textContent = "";
  updateSuggestions();
}
function renderHistory() {
  $("history-list").replaceChildren();
  const records = state.records
    .filter((r) => !r.deleted || state.outbox[r.id])
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!records.length) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = "No completed workouts yet. Your draft stays separate.";
    $("history-list").append(p);
  }
  for (const record of records) {
    const button = document.createElement("button");
    button.className = "record";
    const row = document.createElement("div");
    row.className = "record-top";
    const title = document.createElement("span");
    title.className = "record-title";
    title.textContent = titleOf(record.text) || "Untitled workout";
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent =
      (record.deleted ? "pending deletion · " : "") +
      (state.outbox[record.id]?.status ||
        (record.serverID && !record.localOnly ? "synced" : "local only"));
    row.append(title, tag);
    const meta = document.createElement("p");
    meta.textContent = dateLabel(record.date);
    button.append(row, meta);
    button.onclick = () => {
      selectedID = record.id;
      showPage("detail");
    };
    $("history-list").append(button);
  }
}
function renderDetail() {
  const record = state.records.find((r) => r.id === selectedID);
  if (!record) {
    showPage("history");
    return;
  }
  const item = state.outbox[record.id];
  $("detail-heading").textContent = titleOf(record.text) || "Untitled workout";
  $("detail-meta").textContent =
    dateLabel(record.date) +
    " · " +
    (item?.status ||
      (record.serverID && !record.localOnly ? "Synced" : "Local only"));
  $("detail-times").textContent = [
    record.startedAt ? "Started: " + record.startedAt.replace("T", " ") : "",
    record.completedAt
      ? "Finished: " + record.completedAt.replace("T", " ")
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  $("snapshot").textContent = record.text;
  $("sync-detail").textContent = item
    ? `${item.status} ${item.operation}. ${item.error || ""}` +
      (item.status === "uncertain"
        ? " The request may have committed. Sync scans ALL history pages by source reference. No automatic workout retry."
        : "")
    : record.syncNote || "";
  $("retry").hidden =
    !item || !["uncertain", "conflict", "blocked"].includes(item.status);
  $("keep-local").hidden = !item || item.status === "sending";
  $("edit-again").disabled = Boolean(record.deleted);
  $("delete-record").disabled = Boolean(record.deleted);
}
async function reloadState(render = false) {
  const next = await activeAccount(),
    changed = next !== account;
  account = next;
  state = await readAccount(account);
  if (changed) {
    draftSequence = 0;
    committedDraftSequence = 0;
    draftSaveError = false;
  }
  storageOK = committedDraftSequence === draftSequence;
  if (changed) {
    selectedID = null;
    showPage("workout");
  } else if (render) showPage(page);
  else {
    if (page === "history") renderHistory();
    if (page === "detail") renderDetail();
    storageStatus();
    updateSuggestions();
  }
}
function persistDraft() {
  if (!activeDraft()) return;
  $("time-error").textContent = "";
  const target = state.edit?.targetId || null,
    partition = account;
  const draft = {
    text: editor.value,
    startedAt: $("started-at").value,
    completedAt: $("completed-at").value,
  };
  Object.assign(activeDraft(), draft);
  const sequence = ++draftSequence;
  draftSaveError = false;
  storageOK = false;
  storageStatus();
  updateSuggestions();
  act(async () => {
    await mutate(
      partition,
      (s) => {
        if (
          (s.edit?.targetId || null) !== target ||
          !(target ? s.edit?.draft : s.draft)
        )
          throw new Error(
            "Draft changed in another tab. Reload before editing further.",
          );
        Object.assign(target ? s.edit.draft : s.draft, draft);
      },
      true,
    );
    if (partition === account) {
      committedDraftSequence = sequence;
      storageOK = committedDraftSequence === draftSequence;
      storageStatus();
    }
  }).catch(() => {
    if (partition === account) {
      draftSaveError = true;
      storageStatus();
    }
  });
}
function acceptSuggestion() {
  const next = nextSuggestion();
  if (!next || next.text !== suggestion?.text) return;
  editor.setRangeText(
    next.text,
    editor.value.length,
    editor.value.length,
    "end",
  );
  editor.focus({ preventScroll: true });
  persistDraft();
}
async function foregroundSync() {
  if (account === "guest" || !navigator.onLine) return;
  if (syncing) {
    syncRequested = true;
    return;
  }
  syncing = true;
  syncRequested = false;
  storageStatus();
  try {
    const result = await syncAccount(account);
    await reloadState();
    // A tab may enqueue while another tab owns the sender, or while this
    // sender is awaiting a slow response. Only known-unsent work is drained.
    if (
      result === false ||
      Object.values(state.outbox).some((i) => i.status === "queued")
    )
      syncRequested = true;
  } catch (error) {
    syncRequested = false;
    if (error instanceof HTTPError && [401, 403].includes(error.status))
      failure(new Error("Sign in again to sync. Local data is safe."));
    else failure(error);
  } finally {
    syncing = false;
    try {
      await reloadState();
    } catch (error) {
      failure(error);
    }
    if (
      syncRequested &&
      Object.values(state.outbox).some((i) => i.status === "queued")
    )
      setTimeout(() => {
        void foregroundSync();
      }, 1000);
  }
}
async function discoverAccount() {
  try {
    const me = await request("/auth/me");
    await setActive(String(me.user_id));
    await reloadState();
    await foregroundSync();
  } catch (error) {
    if (!(error instanceof HTTPError && error.status === 401)) failure(error);
  }
}
editor.addEventListener("input", persistDraft);
["click", "keyup", "select", "focus"].forEach((event) =>
  editor.addEventListener(event, updateSuggestions),
);
editor.addEventListener("blur", () => {
  if (document.activeElement !== $("accept")) updateSuggestions();
});
editor.addEventListener("compositionstart", () => {
  composing = true;
  updateSuggestions();
});
editor.addEventListener("compositionend", () => {
  composing = false;
  persistDraft();
});
editor.addEventListener("keydown", (event) => {
  if (
    event.key === "Tab" &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.isComposing &&
    suggestion
  ) {
    event.preventDefault();
    acceptSuggestion();
  }
});
$("accept").addEventListener("pointerdown", (event) => event.preventDefault());
$("accept").onclick = () => {
  editor.focus({ preventScroll: true });
  acceptSuggestion();
};
editor.addEventListener(
  "touchstart",
  (event) => {
    gesture = null;
    if (
      event.touches.length !== 1 ||
      !suggestion ||
      composing ||
      editor.selectionStart !== editor.selectionEnd
    )
      return;
    const touch = event.touches[0],
      range = document.createRange();
    range.selectNodeContents($("ghost"));
    if (
      Array.from(range.getClientRects()).some(
        (r) =>
          touch.clientX >= r.left - 4 &&
          touch.clientX <= r.right + 12 &&
          touch.clientY >= r.top - 6 &&
          touch.clientY <= r.bottom + 6,
      )
    )
      gesture = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
        value: editor.value,
        text: suggestion.text,
        scroll: window.scrollY,
      };
  },
  { passive: true },
);
editor.addEventListener(
  "touchmove",
  (event) => {
    if (
      gesture &&
      (event.touches.length !== 1 ||
        Math.abs(event.touches[0].clientY - gesture.y) > 24)
    )
      gesture = null;
  },
  { passive: true },
);
editor.addEventListener(
  "touchcancel",
  () => {
    gesture = null;
  },
  { passive: true },
);
editor.addEventListener(
  "touchend",
  (event) => {
    const start = gesture;
    gesture = null;
    if (!start || event.touches.length || event.changedTouches.length !== 1)
      return;
    const touch = event.changedTouches[0];
    if (
      touch.clientX - start.x >= 56 &&
      Math.abs(touch.clientY - start.y) <= 24 &&
      Date.now() - start.time < 500 &&
      Math.abs(window.scrollY - start.scroll) < 4 &&
      editor.value === start.value &&
      suggestion?.text === start.text &&
      editor.selectionStart === editor.selectionEnd
    )
      acceptSuggestion();
  },
  { passive: true },
);
window.addEventListener("resize", updateSuggestions);
for (const id of ["started-at", "completed-at"])
  $(id).addEventListener("input", () => {
    $("time-error").textContent = "";
    persistDraft();
  });
$("history-toggle").onclick = () =>
  showPage(page === "workout" ? "history" : "workout");
$("back-history").onclick = () => showPage("history");
const startFresh = guard(async () => {
  if (state.edit) throw new Error("Save or cancel your edit first.");
  if (
    state.draft?.text.trim() &&
    !confirm("Replace your current draft? Completed workouts stay unchanged.")
  )
    return;
  await mutate(
    account,
    (s) => {
      if (s.edit) throw new Error("An edit is open in another tab.");
      s.draft = freshDraft();
    },
    true,
  );
  await reloadState();
  showPage("workout");
  editor.focus();
});
$("new-workout").onclick = startFresh;
$("start-from-empty").onclick = startFresh;
$("edit-again").onclick = guard(async () => {
  const id = selectedID;
  if (
    state.edit &&
    state.edit.targetId !== id &&
    !confirm("Discard the other unsaved edit?")
  )
    return;
  await mutate(
    account,
    (s) => {
      const r = s.records.find((r) => r.id === id);
      if (!r) throw new Error("Record no longer exists.");
      if (s.edit?.targetId !== id)
        s.edit = {
          targetId: id,
          draft: {
            text: r.text,
            startedAt: r.startedAt || "",
            completedAt: r.completedAt || "",
          },
        };
    },
    true,
  );
  await reloadState();
  showPage("workout");
  editor.focus();
});
$("cancel-edit").onclick = guard(async () => {
  selectedID = state.edit?.targetId;
  await mutate(
    account,
    (s) => {
      delete s.edit;
    },
    true,
  );
  await reloadState();
  showPage("detail");
});
$("complete").onclick = guard(async () => {
  if (!activeDraft()) return;
  // The textarea is authoritative even if a slow cache refresh replaced the
  // in-memory snapshot while an autosave transaction was committing.
  const draft = {
    text: editor.value,
    startedAt: $("started-at").value,
    completedAt: $("completed-at").value,
  };
  let payload;
  const existing = state.records.find((r) => r.id === state.edit?.targetId);
  try {
    payload = workoutPayload(draft, existing?.date);
  } catch (error) {
    $("time-error").textContent = error.message;
    return;
  }
  const id = existing?.id || uuid(),
    editing = Boolean(state.edit),
    expectedTarget = state.edit?.targetId;
  await mutate(
    account,
    (s) => {
      if (s.edit?.targetId !== expectedTarget)
        throw new Error("Edit changed in another tab.");
      const latest = editing ? s.edit?.draft : s.draft;
      if (
        !latest ||
        latest.text !== draft.text ||
        (latest.startedAt || "") !== draft.startedAt ||
        (latest.completedAt || "") !== draft.completedAt
      )
        throw new Error(
          "Draft changed in another tab. Review before completion.",
        );
      const previous = s.records.find((r) => r.id === id);
      const record = {
        ...previous,
        id,
        text: draft.text,
        date: payload.performed_on,
        startedAt: draft.startedAt || "",
        completedAt: draft.completedAt || "",
        version: (previous?.version || 0) + 1,
        localOnly: account === "guest",
      };
      s.records = s.records.filter((r) => r.id !== id);
      s.records.unshift(record);
      if (account !== "guest") queueRecord(s, record);
      if (editing) delete s.edit;
      else s.draft = null;
    },
    true,
  );
  selectedID = id;
  await reloadState();
  showPage("detail");
  announce(
    editing ? "Changes saved locally." : "Workout completed and saved locally.",
  );
  void foregroundSync();
});
$("delete-record").onclick = guard(async () => {
  if (
    !confirm(
      "Delete this workout? Synced deletion is last-write-wins across devices.",
    )
  )
    return;
  await mutate(
    account,
    (s) => {
      const r = s.records.find((r) => r.id === selectedID);
      if (!r) return;
      const item = s.outbox[r.id];
      if (
        !r.serverID &&
        (!item || item.status === "queued" || item.status === "blocked")
      ) {
        s.records = s.records.filter((x) => x.id !== r.id);
        delete s.outbox[r.id];
      } else {
        r.deleted = true;
        r.version++;
        if (account !== "guest") queueRecord(s, r);
      }
      if (s.edit?.targetId === r.id) delete s.edit;
    },
    true,
  );
  await reloadState();
  showPage("history");
  void foregroundSync();
});
$("retry").onclick = guard(async () => {
  const item = state.outbox[selectedID];
  if (
    !confirm(
      item?.operation === "create" &&
        ["uncertain", "conflict"].includes(item.status)
        ? "DANGER: the server may already contain this workout. Sync first to reconcile. Deliberately send a NEW create anyway? This can make duplicates. Export a backup first."
        : "Explicitly retry this replacement/deletion? It may overwrite newer remote data (last-write-wins).",
    )
  )
    return;
  await resolveRecord(account, selectedID);
  await reloadState();
  void foregroundSync();
});
$("keep-local").onclick = guard(async () => {
  if (
    !confirm(
      "Stop syncing this record and keep its content locally? Any earlier uncertain server write may still exist.",
    )
  )
    return;
  await resolveRecord(account, selectedID, true);
  await reloadState();
});
$("import-toggle").onclick = () => {
  $("import-error").textContent = "";
  $("import-dialog").showModal();
  $("program-input").focus();
};
$("cancel-import").onclick = () => $("import-dialog").close();
$("import-form").onsubmit = (event) => {
  event.preventDefault();
  guard(async () => {
    try {
      const days = parseProgram($("program-input").value);
      await importPrograms(account, days);
      await reloadState();
      $("import-dialog").close();
      announce(days.length + " program days saved locally.");
      void foregroundSync();
    } catch (error) {
      $("import-error").textContent = error.message;
    }
  })();
};
$("resolve-programs").onclick = guard(async () => {
  if (
    !confirm(
      "Retry failed program imports, replacing remote programs using their latest known revision? Review/export first.",
    )
  )
    return;
  await mutate(
    account,
    (s) => {
      for (const p of s.programs) {
        const item = s.outbox[p.id];
        if (!["conflict", "blocked"].includes(item?.status)) continue;
        if (p.remote) p.revision = p.remote.updated_at;
        item.operation = p.revision ? "update" : "create";
        item.status = "queued";
        item.error = "";
      }
    },
    true,
  );
  await reloadState();
  void foregroundSync();
});
$("sync").onclick = () => {
  if (account === "guest")
    announce(
      "Guest records stay on this device. Sign in, then explicitly adopt them to sync.",
    );
  else void discoverAccount();
};
$("adopt").onclick = guard(async () => {
  if (
    !confirm(
      "Move guest completed records and programs into this account and upload them? Guest drafts stay separate.",
    )
  )
    return;
  await adoptGuest(account);
  await reloadState();
  void foregroundSync();
});
$("export").onclick = guard(async () => {
  const saved = await readAccount(account),
    blob = new Blob(
      [JSON.stringify({ format: "djym-backup-v1", ...saved }, null, 2)],
      { type: "application/json" },
    ),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = `djym-${account}-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});
$("backup-input").onchange = guard(async () => {
  const file = $("backup-input").files[0];
  if (!file) return;
  if (file.size > 10000000) throw new Error("Backup exceeds 10 MB.");
  if (
    !confirm(
      "Restore as guest local-only records? Nothing will upload automatically. Existing records remain.",
    )
  )
    return;
  const saved = JSON.parse(await file.text());
  await importBackup(saved);
  await setActive("guest");
  await reloadState(true);
  $("backup-input").value = "";
  announce("Backup restored into guest storage.");
});
$("login").onclick = guard(async () => {
  clearTimeout(pollTimer);
  const result = await request("/auth/telegram/login", "POST");
  const link = new URL(result.bot_url);
  if (link.origin !== "https://t.me")
    throw new Error("Unexpected Telegram login URL.");
  $("bot-link").href = link.href;
  $("bot-link").hidden = false;
  loginExpiry = Date.parse(result.expires_at);
  announce("Open Telegram to confirm, then return here.");
  const poll = async () => {
    if (Date.now() > loginExpiry) {
      failure(new Error("Login expired. Start sign-in again."));
      return;
    }
    try {
      const result = await request("/auth/telegram/poll", "POST");
      if (result.status === "confirmed") {
        $("bot-link").hidden = true;
        await discoverAccount();
        return;
      }
      pollTimer = setTimeout(poll, 2000);
    } catch (error) {
      failure(error);
    }
  };
  pollTimer = setTimeout(poll, 1500);
});
$("logout").onclick = guard(async () => {
  await request("/auth/logout", "POST");
  clearTimeout(pollTimer);
  await setActive("guest");
  await reloadState(true);
  announce("Signed out. Account data remains partitioned on this device.");
});
if (changes)
  changes.onmessage = () => {
    act(() => reloadState()).catch(() => {});
  };
window.addEventListener("online", () => {
  void discoverAccount();
});
window.addEventListener("offline", storageStatus);
window.addEventListener("pageshow", () => {
  if (storageOK) void discoverAccount();
});
async function init() {
  try {
    try {
      await migrateLegacy();
    } catch (error) {
      failure(
        new Error(
          "Prototype import failed; original key left untouched. " +
            error.message,
        ),
      );
    }
    await recoverAccount(await activeAccount());
    await reloadState(true);
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(failure);
    } else
      $("install-note").textContent =
        "Offline shell/install needs HTTPS (or localhost on this device). HTTP on a LAN address cannot install a service worker.";
    void discoverAccount();
  } catch (error) {
    $("complete").disabled = true;
    failure(
      new Error(
        "Device storage unavailable. Nothing can be saved: " + error.message,
      ),
    );
  }
}
void init();
