/// <reference lib="es2022" />
import { today, WORKOUT_TYPES } from './model.ts';
import type { Draft, DraftExercise, DraftSet, Workout } from './model.ts';
import { normalizeName } from './programs.ts';

export type MessageIssueCode = 'empty' | 'bad_date' | 'bad_intake' | 'no_sets' | 'no_name' | 'bad_token' | 'zero_reps';
export type MessageIssue = { code: MessageIssueCode; line: number; text: string; token?: string };
export type MessageParse = { ok: true; draft: Draft } | { ok: false; issue: MessageIssue };
export type FormatResult = { text: string; lossless: boolean; reasons: string[] };
const DATE = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/;
const ISO_DATE = /^(\d{4})-(\d\d)-(\d\d)$/;
const TOKEN = /^(\d+(?:\.\d{1,2})?)?-(\d*)$/;
const INTAKE = /\(\s*(\d+)\s*\/\s*(\d+)(?:\s+[^)]*)?\)/;
const id = (prefix: string, n: number) => `${prefix}:${n}`;
function validDate(value: string): boolean { const d = new Date(`${value}T12:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value; }
function parseDate(token: string, now: Date): string | null {
  const iso = ISO_DATE.exec(token);
  if (iso) return validDate(token) ? token : null;
  const m = DATE.exec(token); if (!m) return null;
  const y = m[3] ?? String(now.getFullYear());
  const date = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return validDate(date) ? date : null;
}
function fail(code: MessageIssueCode, line: number, text: string, token?: string): MessageParse { return { ok: false, issue: { code, line, text, ...(token === undefined ? {} : { token }) } }; }
function wordChar(char: string | undefined): boolean { return !!char && (char.toLocaleLowerCase() !== char.toLocaleUpperCase() || /[0-9]/.test(char)); }
function sameEntry(a: DraftExercise, b: DraftExercise): boolean {
  const namesA = [a.name, a.canonicalName ?? ''].map(normalizeName).filter(Boolean);
  return [b.name, b.canonicalName ?? ''].map(normalizeName).some(n => namesA.includes(n));
}

/** Parse a whole multiline message. Header notes use `|` so free workout names remain unambiguous. */
export function parseWorkoutMessage(text: string, base: Draft, now = new Date()): MessageParse {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const nonblank = lines.map((raw, i) => ({ raw: raw.trim(), line: i + 1 })).filter(x => x.raw);
  if (!nonblank.length) return fail('empty', 0, '');
  let date = today(now), title = base.title, notes = base.notes, kcal = base.kcal, proteinG = base.proteinG;
  let start = 0;
  const first = nonblank[0];
  const fields = first.raw.split(/\s+/);
  const maybeDate = parseDate(fields[0], now);
  if (!maybeDate && (/^\d{1,2}\.\d{1,2}(?:\.\d{4})?$/.test(fields[0]) || /^\d{4}-\d\d-\d\d$/.test(fields[0]))) return fail('bad_date', first.line, first.raw, fields[0]);
  const hasFirstLineSets = fields.some(w => TOKEN.test(w) && (TOKEN.exec(w)?.[1] || TOKEN.exec(w)?.[2]));
  if (maybeDate || !hasFirstLineSets) {
    start = 1;
    if (maybeDate) date = maybeDate;
    let rest = maybeDate ? first.raw.slice(fields[0].length).trim() : first.raw;
    const intake = INTAKE.exec(rest);
    if (intake) {
      const k = Number(intake[1]), p = Number(intake[2]);
      if (!Number.isSafeInteger(k) || !Number.isSafeInteger(p)) return fail('bad_intake', first.line, first.raw, intake[0]);
      kcal = k; proteinG = p; rest = `${rest.slice(0, intake.index)} ${rest.slice(intake.index + intake[0].length)}`.replace(/\s+/g, ' ').trim();
    }
    const separator = rest.indexOf('|');
    const heading = (separator < 0 ? rest : rest.slice(0, separator)).trim();
    const oldType = WORKOUT_TYPES.find(t => heading.toLowerCase().startsWith(t.toLowerCase()) && (heading.length === t.length || !wordChar(Array.from(heading.slice(t.length))[0])));
    title = heading ? (oldType && normalizeName(heading) === normalizeName(oldType) ? oldType : heading) : base.title;
    const headerNote = separator < 0 ? '' : rest.slice(separator + 1).trim();
    if (headerNote && headerNote !== base.notes.trim()) notes = [base.notes, headerNote].filter(Boolean).join('\n');
  }
  const exercises: DraftExercise[] = [];
  const claimedOriginalExercises = new Set<number>();
  const reservedIds = new Set(base.exercises.flatMap(entry => [entry.id, ...entry.sets.map(set => set.id)]));
  const usedIds = new Set<string>();
  const allocateId = (candidate: string): string => {
    if (!reservedIds.has(candidate) && !usedIds.has(candidate)) { usedIds.add(candidate); return candidate; }
    let suffix = 1; let allocated = `${candidate}:${suffix}`;
    while (reservedIds.has(allocated) || usedIds.has(allocated)) allocated = `${candidate}:${++suffix}`;
    usedIds.add(allocated); return allocated;
  };
  const retainId = (original: string | undefined, candidate: string): string => {
    if (original && !usedIds.has(original)) { usedIds.add(original); return original; }
    return allocateId(candidate);
  };
  for (const item of nonblank.slice(start)) {
    const words = item.raw.split(/\s+/); const firstToken = words.findIndex(w => TOKEN.test(w) && (TOKEN.exec(w)?.[1] || TOKEN.exec(w)?.[2]));
    if (firstToken < 0) return fail('no_sets', item.line, item.raw);
    if (firstToken === 0) return fail('no_name', item.line, item.raw, words[0]);
    const name = words.slice(0, firstToken).join(' '); let weight = '0'; const sets: DraftSet[] = [];
    for (const word of words.slice(firstToken)) {
      const m = TOKEN.exec(word);
      if (!m || (!m[1] && !m[2])) return fail('bad_token', item.line, item.raw, word);
      if (m[2] === '0') return fail('zero_reps', item.line, item.raw, word);
      if (m[1]) weight = m[1];
      sets.push({ id: id('message-set', sets.length), kg: weight, reps: m[2], ...(!m[2] ? { planned: true } : {}) });
    }
    const fresh: DraftExercise = { id: '', name, sets };
    const oldIndex = base.exercises.findIndex((entry, index) => !claimedOriginalExercises.has(index) && sameEntry(entry, fresh));
    const old = oldIndex < 0 ? undefined : base.exercises[oldIndex];
    if (old) claimedOriginalExercises.add(oldIndex);
    const exerciseIndex = exercises.length;
    const exerciseId = retainId(old?.id, `message-exercise:${exerciseIndex}`);
    exercises.push({ ...fresh, id: exerciseId, ...(old?.canonicalName ? { canonicalName: old.canonicalName } : {}), sets: sets.map((set, index) => ({ ...set, id: retainId(old?.sets[index]?.id, `message-set:${exerciseIndex}:${index}`) })) });
  }
  return { ok: true, draft: { ...base, date, title, notes, kcal, proteinG, exercises, messageText: text } };
}

/** Render only fields representable by Telegram text; reasons tell callers what structured data to retain. */
export function formatWorkoutMessage(draft: Draft): FormatResult {
  const reasons: string[] = [];
  if (draft.notes.trim() && (/[\r\n]/.test(draft.notes) || draft.notes !== draft.notes.trim().replace(/\s+/g, ' '))) reasons.push('notes cannot be represented without changing whitespace');
  if ((draft.kcal != null) !== (draft.proteinG != null)) reasons.push('partial intake metadata requires the structured editor');
  if (draft.legacyType && normalizeName(draft.legacyType) !== normalizeName(draft.title)) reasons.push('legacyType differs from title');
  if (draft.remoteId || draft.revision || draft.source || draft.sourceRef || draft.startedAt || draft.finishedAt) reasons.push('remote/source/timestamp metadata is not representable');
  if (draft.exercises.some(entry => entry.canonicalName && normalizeName(entry.canonicalName) !== normalizeName(entry.name))) reasons.push('exercise aliases are not representable');
  const header = `${draft.date.slice(8, 10)}.${draft.date.slice(5, 7)}.${draft.date.slice(0, 4)}${draft.title ? ` ${draft.title}` : ''}${draft.kcal != null || draft.proteinG != null ? ` (${draft.kcal ?? 0}/${draft.proteinG ?? 0})` : ''}${draft.notes.trim() ? ` | ${draft.notes.trim().replace(/\s+/g, ' ')}` : ''}`;
  const rows = draft.exercises.map(entry => {
    if (!entry.sets.length) reasons.push(`empty exercise preserved: ${entry.name}`);
    let prior = '';
    const setTokens = entry.sets.map(set => {
      const kg = String(set.kg).replace(',', '.'); const explicit = set.planned || !prior || kg !== prior;
      prior = kg;
      if (!set.reps.trim()) { reasons.push(`incomplete set preserved: ${entry.name}`); return `${explicit && kg !== '0' ? kg : ''}-`; }
      return `${explicit && kg !== '0' ? kg : ''}-${set.reps}`;
    });
    return `${entry.name}${setTokens.length ? ` ${setTokens.join(' ')}` : ''}`;
  });
  return { text: [header, ...rows].join('\n'), lossless: reasons.length === 0, reasons: Array.from(new Set(reasons)) };
}

/** Merge parsed message fields while preserving stable workout identity and unrelated metadata. */
export function applyWorkoutMessage(text: string, base: Draft, now = new Date()): MessageParse {
  return parseWorkoutMessage(text, base, now);
}

export type MessageWorkout = Workout;
