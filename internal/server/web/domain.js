export const normalize = (text) =>
  text.normalize("NFC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
export const normalizeTitle = (text) =>
  normalize(text).replace(/\s*[—–-]\s*/g, " - ");
export const titleOf = (text) =>
  (text.split("\n").find((line) => line.trim()) || "")
    .trim()
    .replace(/^\d{1,2}\.\d{1,2}(?:\.\d{4})?(?:\s+|$)/, "")
    .replace(/\(\d+\/\d+[^)]*\)/g, "")
    .trim();
export function uuid() {
  // crypto.randomUUID requires HTTPS; getRandomValues also works in HTTP guest mode.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function freshDraft() {
  const now = new Date();
  return {
    text: `${String(now.getDate()).padStart(2, "0")}.${String(now.getMonth() + 1).padStart(2, "0")}.${now.getFullYear()} `,
  };
}
export function workoutDate(text, referenceDate) {
  const match = text
    .trimStart()
    .match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?:\s|$)/);
  if (!match)
    throw new Error("Start with a valid date: DD.MM.YYYY and any title.");
  const year = Number(
    match[3] || referenceDate?.slice(0, 4) || new Date().getFullYear(),
  );
  const month = Number(match[2]),
    day = Number(match[1]);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  if (
    year < 1 ||
    year > 9999 ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  )
    throw new Error("Invalid workout date.");
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
export function wallTime(value) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value))
    throw new Error("Invalid workout time.");
  const date = new Date(value);
  // Reject non-existent local times (e.g. daylight-saving spring-forward).
  if (!Number.isFinite(+date) || localTime(date.toISOString()) !== value)
    throw new Error("This wall-clock time does not exist in your timezone.");
  return date.toISOString();
}
export function localTime(value) {
  if (!value) return "";
  const date = new Date(value),
    pad = (n) => String(n).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function exerciseLine(line) {
  const planned = line
    .trim()
    .match(/^(.+?)\s+[—–-]\s*\d+\s*[×x]\s*\d+(?:\s*[—–-]\s*\d+)?$/i);
  if (planned) return { name: planned[1], sets: "", target: true };
  const match = line.trim().match(/^(.*?)\s+((?:\d+(?:\.\d{1,2})?)?-\d*.*)$/);
  return match
    ? { name: match[1], sets: match[2] }
    : { name: line.trim(), sets: "" };
}
export function parseActual(line) {
  const parsed = exerciseLine(line);
  if (parsed.target)
    throw new Error(
      "Replace planned ranges with actual weight-reps, or remove the planned line. Targets are not completed sets.",
    );
  if (!parsed.name || !parsed.sets)
    throw new Error(
      "Each exercise needs actual sets, for example: Squat 60-10 -9 (bodyweight: -10).",
    );
  let weight = "0";
  const sets = parsed.sets
    .trim()
    .split(/\s+/)
    .map((token) => {
      const match = token.match(/^(\d{1,4}(?:\.\d{1,2})?)?-(\d+)$/);
      if (
        !match ||
        !Number.isSafeInteger(Number(match[2])) ||
        Number(match[2]) < 1 ||
        Number(match[2]) > 2147483647
      )
        throw new Error(
          'Invalid set "' +
            token +
            '". Use weight-reps, then -reps to repeat the weight.',
        );
      if (match[1]) weight = match[1];
      return { weight, reps: Number(match[2]) };
    });
  return { name: parsed.name, sets };
}
export function workoutPayload(draft, referenceDate) {
  const performed_on = workoutDate(draft.text, referenceDate),
    name = titleOf(draft.text);
  if ([...name].length > 2000) throw new Error("Workout title is too long.");
  const entries = draft.text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim())
    .map(parseActual);
  if (!entries.length)
    throw new Error("Add at least one exercise with actual sets.");
  const payload = { performed_on, name, raw_text: draft.text, entries };
  if (Boolean(draft.startedAt) !== Boolean(draft.completedAt))
    throw new Error(
      "For completion, supply both start and finish, or clear both. Incomplete times can stay in a draft.",
    );
  if (draft.startedAt) {
    payload.started_at = wallTime(draft.startedAt);
    payload.finished_at = wallTime(draft.completedAt);
    if (payload.finished_at < payload.started_at)
      throw new Error("Finish must be at or after start.");
  }
  return payload;
}
export function parseProgram(text) {
  const days = [];
  let day;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const fail = (message) => {
      throw new Error(`Line ${index + 1}: ${message}`);
    };
    const heading = line.match(/^Day\s+(\d+)\s*[—–-]\s*(.+)$/i);
    if (heading) {
      if (day && !day.entries.length) fail("previous day is empty.");
      const name = `Day ${Number(heading[1])} — ${heading[2].replace(/\s+/g, " ").trim()}`;
      if (
        !Number.isSafeInteger(Number(heading[1])) ||
        Number(heading[1]) < 1 ||
        days.some((d) => normalizeTitle(d.name) === normalizeTitle(name)) ||
        [...name].length > 2000
      )
        fail("use unique valid day titles.");
      day = { id: uuid(), name, entries: [] };
      days.push(day);
      continue;
    }
    if (!day) fail("start with Day 1 — Upper.");
    const match = line.match(
      /^(.+?)\s*[—–-]\s*(\d+)\s*[×x]\s*(\d+)(?:\s*[—–-]\s*(\d+))?$/i,
    );
    if (!match) fail("expected Exercise — 3×6–8. Nothing was imported.");
    const [, name, s, min, max = min] = match,
      values = [Number(s), Number(min), Number(max)];
    if (
      !values.every(Number.isSafeInteger) ||
      values[0] < 1 ||
      values[0] > 100 ||
      values[1] < 1 ||
      values[2] > 9999 ||
      values[1] > values[2] ||
      [...name].length > 2000 ||
      day.entries.length >= 100 ||
      day.entries.some((e) => normalize(e.name) === normalize(name))
    )
      fail("invalid or duplicate exercise / set / rep range.");
    day.entries.push({
      name: name.trim(),
      set_count: values[0],
      target_reps: null,
      target_reps_min: values[1],
      target_reps_max: values[2],
    });
  }
  if (!day?.entries.length)
    throw new Error("Add at least one nonempty program day.");
  return days;
}
export function programView(program) {
  return {
    ...program,
    alias: program.name.replace(/^Day\s+\d+\s*[—–-]\s*/i, ""),
    exercises: program.entries.map((e) => e.name),
    targets: program.entries.map((e) => ({
      sets: e.set_count,
      min: e.target_reps_min ?? e.target_reps,
      max: e.target_reps_max ?? e.target_reps,
    })),
  };
}
export function matchProgram(programs, text) {
  const title = normalizeTitle(titleOf(text));
  const exact = programs.filter((p) => normalizeTitle(p.name) === title);
  if (exact.length) return exact.length === 1 ? programView(exact[0]) : null;
  const short = programs
    .map(programView)
    .filter((p) => normalizeTitle(p.alias) === title);
  return short.length === 1 ? short[0] : null;
}
export const targetText = (target) =>
  target.sets +
  "×" +
  target.min +
  (target.min === target.max ? "" : "–" + target.max);
export const emptyState = () => ({
  draft: freshDraft(),
  records: [],
  programs: [],
  outbox: {},
});
export function fromServer(row) {
  return {
    id: "server-" + row.id,
    serverID: row.id,
    revision: row.updated_at,
    sourceRef: row.source_ref,
    text: row.raw_text,
    date: row.performed_on,
    startedAt: localTime(row.started_at),
    completedAt: localTime(row.finished_at),
    version: 1,
    remote: row,
  };
}
// Compare the sent projection, not local edited text or timestamp precision.
export function sameWorkout(row, payload) {
  const project = (data, server) => ({
    date: data.performed_on,
    name: data.name || "",
    raw: data.raw_text,
    entries: (data.entries || []).map((e) => ({
      name: server ? e.name_as_written : e.name,
      sets: (e.sets || []).map((s) => ({
        weight: Number(s.weight),
        reps: s.reps,
      })),
    })),
    start: data.started_at ? new Date(data.started_at).toISOString() : null,
    finish: data.finished_at ? new Date(data.finished_at).toISOString() : null,
    type: data.type || null,
    kcal: data.kcal ?? null,
    protein: data.protein_g ?? null,
    note: data.note || null,
  });
  return (
    JSON.stringify(project(row, true)) ===
    JSON.stringify(project(payload, false))
  );
}
