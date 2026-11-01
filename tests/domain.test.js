import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseProgram,
  matchProgram,
  workoutPayload,
  parseActual,
  workoutDate,
  wallTime,
  localTime,
  sameWorkout,
  uuid,
} from "../internal/server/web/domain.js";
import {
  importedState,
  changes,
  queueRecord,
} from "../internal/server/web/db.js";
process.env.TZ = "America/Los_Angeles";
after(() => changes?.close());
const fixture = readFileSync(new URL("./program.txt", import.meta.url), "utf8");
test("five-day 47-exercise reference fixture preserves order, slash names and ranges", () => {
  const days = parseProgram(fixture);
  assert.equal(days.length, 5);
  assert.equal(
    days.reduce((n, d) => n + d.entries.length, 0),
    47,
  );
  assert.equal(days[0].entries[0].name, "Incline Smith/dumbbell press");
  assert.equal(days[0].entries[12].name, "Reverse pec deck / Face pull");
  assert.deepEqual(days[0].entries[0], {
    name: "Incline Smith/dumbbell press",
    set_count: 3,
    target_reps: null,
    target_reps_min: 6,
    target_reps_max: 8,
  });
  assert.equal(matchProgram(days, "03.10.2026  UPPER \n").id, days[0].id);
  assert.equal(
    matchProgram(days, "03.10.2026 Day 5 - Arms + Delts\n").id,
    days[4].id,
  );
  assert.equal(matchProgram(days, "03.10.2026 Upper extra"), null);
  assert.equal(
    matchProgram(
      [...days, { ...days[0], id: uuid(), name: "Day 6 — Upper" }],
      "03.10.2026 Upper",
    ),
    null,
  );
  assert.match(days[0].id, /^[0-9a-f-]{36}$/);
});
test("program parser all-or-nothing validation and API bounds", () => {
  for (const text of [
    "Day 1 — Upper\nBench — 0×6–8",
    "Day 1 — Upper\nBench — 101×6–8",
    "Day 1 — Upper\nBench — 3×8–6",
    "Day 1 — Upper\nBench — 3×6–10000",
    "Day 1 — Upper\nBench — 3×6–8\nbench — 2×8",
    "Day 1 — Upper\nDay 2 — Lower\nSquat — 2×8",
  ])
    assert.throws(() => parseProgram(text));
  assert.equal(
    parseProgram("Day 1 — Test\nX — 1×9–9")[0].entries[0].target_reps_max,
    9,
  );
});
test("actual sets validate every token, no fabricated planned sets", () => {
  assert.deepEqual(
    parseActual("Incline Smith/dumbbell press 60-10 -9 13.50-8"),
    {
      name: "Incline Smith/dumbbell press",
      sets: [
        { weight: "60", reps: 10 },
        { weight: "60", reps: 9 },
        { weight: "13.50", reps: 8 },
      ],
    },
  );
  assert.deepEqual(parseActual("Abs -20 -19").sets, [
    { weight: "0", reps: 20 },
    { weight: "0", reps: 19 },
  ]);
  for (const line of [
    "Bench — 3×6–8",
    "Bench 60-",
    "Bench 60-0",
    "Bench 1.123-8",
    "Bench 10000-8",
    "Bench 20-8 garbage",
    "Bench 20-8 -",
    "Bench 20-99999999999999",
    "Bench",
  ])
    assert.throws(() => parseActual(line), line);
  const raw = "03.10.2026 My free title\nBench 60-10 -9";
  const payload = workoutPayload({ text: raw });
  assert.equal(payload.raw_text, raw);
  assert.equal(payload.name, "My free title");
  assert.equal(payload.performed_on, "2026-10-03");
});
test("dates reject invalid headers; yearless edits preserve saved year", () => {
  assert.equal(workoutDate("02.05 title", "2018-05-02"), "2018-05-02");
  for (const text of [
    "31.02.2026 title",
    "29.02.2025 title",
    "anything",
    "01.13.2026 title",
    "00.10.2026 title",
  ])
    assert.throws(() => workoutDate(text));
  assert.equal(workoutDate("29.02.2024 leap"), "2024-02-29");
});
test("wall-clock times safely convert to RFC3339 and reject partial/nonexistent times", () => {
  const text = "03.10.2026 Upper\nBench 60-10";
  const payload = workoutPayload({
    text,
    startedAt: "2026-10-03T23:30",
    completedAt: "2026-10-04T00:15",
  });
  assert.equal(payload.started_at, "2026-10-04T06:30:00.000Z");
  assert.equal(localTime(payload.started_at), "2026-10-03T23:30");
  assert.throws(() => wallTime("2026-03-08T02:30"));
  assert.throws(() => workoutPayload({ text, startedAt: "2026-10-03T23:30" }));
  assert.throws(() =>
    workoutPayload({
      text,
      startedAt: "2026-10-03T23:30",
      completedAt: "2026-10-03T23:00",
    }),
  );
});
test("uncertain replacement comparison is semantic, not object key order or timestamp precision", () => {
  const payload = workoutPayload({ text: "03.10.2026 Upper\nBench 060-10 -9" });
  const row = {
    id: 5,
    name: payload.name,
    performed_on: payload.performed_on,
    raw_text: payload.raw_text,
    entries: [
      {
        name_as_written: "Bench",
        sets: [
          { weight: "60", reps: 10 },
          { weight: "60.00", reps: 9 },
        ],
      },
    ],
  };
  assert.equal(sameWorkout(row, payload), true);
  assert.equal(sameWorkout({ ...row, name: "changed" }, payload), false);
});
test("legacy migration strips fixtures/provenance but preserves raw content, draft, edit, targets", () => {
  const legacy = {
    draft: { text: "draft" },
    records: [
      { id: "own", text: "legacy invalid actual text", date: "2018-05-02" },
      { id: "sample-upper", text: "demo", date: "2026-01-01" },
    ],
    programs: [
      {
        name: "Day 1 — Upper",
        exercises: ["Bench"],
        targets: [{ sets: 3, min: 6, max: 8 }],
      },
    ],
    edit: { targetId: "own", draft: { text: "editing" } },
  };
  const migrated = importedState(legacy, true);
  assert.equal(migrated.records.length, 1);
  assert.equal(migrated.records[0].text, "legacy invalid actual text");
  assert.equal(migrated.edit.targetId, migrated.records[0].id);
  assert.equal(migrated.programs[0].entries[0].target_reps_max, 8);
  assert.deepEqual(migrated.outbox, {});
  const backup = importedState({
    ...migrated,
    records: migrated.records.map((r) => ({
      ...r,
      serverID: 999,
      sourceRef: uuid(),
    })),
  });
  assert.equal(backup.records[0].serverID, undefined);
  assert.deepEqual(backup.outbox, {});
  assert.throws(() =>
    importedState({ draft: { text: "x" }, records: [{ text: 1, date: "x" }] }),
  );
});
test("pending creates coalesce; dispatched attempts remain immutable through edits/deletes", () => {
  const record = { id: uuid(), version: 1 },
    state = { outbox: {} };
  queueRecord(state, record);
  record.version++;
  queueRecord(state, record);
  assert.equal(state.outbox[record.id].version, 2);
  state.outbox[record.id].status = "sending";
  state.outbox[record.id].payload = { raw_text: "immutable" };
  record.version++;
  record.deleted = true;
  queueRecord(state, record);
  assert.equal(state.outbox[record.id].version, 2);
  assert.equal(state.outbox[record.id].payload.raw_text, "immutable");
});
