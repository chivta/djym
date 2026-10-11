import { isDate, toDraft, validateDraft, WORKOUT_TYPES } from './model.ts';
import type { Workout } from './model.ts';

export type ErrorCode = 'configuration' | 'network' | 'invalid_response' | 'unauthorized' | 'conflict' | 'workout_not_found' | 'login_expired' | 'login_invalid' | 'request_failed';
export class ApiError extends Error {
  code: ErrorCode;
  status: number;
  constructor(code: ErrorCode, status = 0) { super(code); this.code = code; this.status = status; }
}
export function apiURL(value: string | undefined): string {
  try {
    const url = new URL(value ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/$/, '');
  } catch { throw new ApiError('configuration'); }
}
export type Session = { apiURL: string; userId: number; token: string; expiresAt: string };
export type Login = { bot_url: string; expires_at: string; nonce: string };
export type Ack = { workout_id: number; updated_at: string; created: boolean; new_exercises: string[] };
export function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiError('invalid_response');
  return v as Record<string, unknown>;
}
export function text(v: unknown): string {
  if (typeof v !== 'string') throw new ApiError('invalid_response');
  return v;
}
export function positive(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new ApiError('invalid_response');
  return v;
}
export function timestamp(v: unknown): string {
  const s = text(v);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s) || !Number.isFinite(Date.parse(s))) throw new ApiError('invalid_response');
  return s;
}
function array(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new ApiError('invalid_response');
  return v;
}
function nullableText(v: unknown): string | null { return v == null ? null : text(v); }
function intake(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ApiError('invalid_response');
  return v;
}
export function remoteWorkout(value: unknown): Workout {
  const v = record(value), id = positive(v.id), date = text(v.performed_on), title = nullableText(v.type) ?? '';
  if (!isDate(date) || (title && !WORKOUT_TYPES.some(t => t === title))) throw new ApiError('invalid_response');
  text(v.raw_text);
  return {
    id: `remote:${id}`, remoteId: id, revision: timestamp(v.updated_at), date, title,
    notes: nullableText(v.note) ?? '', source: text(v.source), sourceRef: text(v.source_ref),
    kcal: intake(v.kcal), proteinG: intake(v.protein_g),
    startedAt: v.started_at == null ? null : timestamp(v.started_at), finishedAt: v.finished_at == null ? null : timestamp(v.finished_at),
    exercises: array(v.entries).map((value, i) => {
      const e = record(value);
      if (!Number.isSafeInteger(e.position) || (e.position as number) < 0) throw new ApiError('invalid_response');
      text(e.exercise);
      const name = text(e.name_as_written);
      if (!name.trim()) throw new ApiError('invalid_response');
      return { id: `entry:${i}`, name, sets: array(e.sets).map((value, j) => {
        const s = record(value), weight = text(s.weight);
        if (!/^\d+(?:\.\d{1,2})?$/.test(weight) || Number(weight) > 9999.99) throw new ApiError('invalid_response');
        return { id: `set:${j}`, kg: Number(weight), reps: positive(s.reps) };
      }) };
    }),
  };
}
export function workoutBody(w: Workout) {
  const entries = w.exercises.map(e => ({ name: e.name, sets: e.sets.map(s => ({ weight: String(s.kg), reps: s.reps })) }));
  const raw = [w.date, w.title, w.kcal == null ? '' : `kcal: ${w.kcal}`, w.proteinG == null ? '' : `protein: ${w.proteinG}g`,
    w.startedAt ? `started_at: ${w.startedAt}` : '', w.finishedAt ? `finished_at: ${w.finishedAt}` : '',
    w.notes, ...entries.map(e => `${e.name}${e.sets.length ? ': ' + e.sets.map(s => `${s.weight}x${s.reps}`).join(', ') : ''}`)].filter(Boolean).join('\n');
  return { performed_on: w.date, type: w.title, kcal: w.kcal, protein_g: w.proteinG, note: w.notes, raw_text: raw,
    entries, started_at: w.startedAt, finished_at: w.finishedAt };
}
export function createApi(base: string, fetcher: typeof fetch = fetch) {
  const url = apiURL(base);
  function authorized(s: Session) {
    if (s.apiURL !== url || !s.token || /\s/.test(s.token)) throw new ApiError('request_failed');
    positive(s.userId); timestamp(s.expiresAt);
  }
  async function request(path: string, method = 'GET', body?: unknown, token?: string): Promise<unknown> {
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      response = await fetcher(url + path, { method, signal: controller.signal, credentials: 'omit', headers: {
        'Content-Type': 'application/json', 'X-Gymbro-Write': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new ApiError('network'); } finally { clearTimeout(timeout); }
    if (!response.ok) {
      let code: ErrorCode = response.status === 401 ? 'unauthorized' : response.status === 409 ? 'conflict' : response.status === 404 ? 'workout_not_found' : 'request_failed';
      try { const e = record(await response.json()).error; if (e === 'login_expired' || e === 'login_invalid') code = e; } catch { /* Status remains authoritative. */ }
      throw new ApiError(code, response.status);
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new ApiError('invalid_response'); }
  }
  return {
    async start(): Promise<Login> {
      const v = record(await request('/auth/telegram/mobile/login', 'POST'));
      const bot = text(v.bot_url), nonce = text(v.nonce);
      if (!/^https:\/\/t\.me\//.test(bot) || !nonce || nonce.length > 128) throw new ApiError('invalid_response');
      return { bot_url: bot, nonce, expires_at: timestamp(v.expires_at) };
    },
    async poll(nonce: string): Promise<Session | null> {
      if (!nonce || nonce.length > 128) throw new ApiError('request_failed');
      const v = record(await request('/auth/telegram/mobile/poll', 'POST', { nonce }));
      if (v.status === 'pending') return null;
      if (v.status !== 'confirmed') throw new ApiError('invalid_response');
      const token = text(v.session_token);
      if (!token || /\s/.test(token)) throw new ApiError('invalid_response');
      return { apiURL: url, userId: positive(v.user_id), token, expiresAt: timestamp(v.expires_at) };
    },
    async me(s: Session) { authorized(s); const v = record(await request('/auth/me', 'GET', undefined, s.token)); if (positive(v.user_id) !== s.userId) throw new ApiError('invalid_response'); },
    async logout(s: Session) { authorized(s); await request('/auth/logout', 'POST', undefined, s.token); },
    async history(s: Session): Promise<Workout[]> {
      authorized(s);
      const all: Workout[] = [], seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const v = record(await request(`/v1/users/${s.userId}/workouts${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, s.token));
        all.push(...array(v.workouts).map(remoteWorkout));
        cursor = v.next_cursor === null ? null : text(v.next_cursor);
        if (cursor !== null) { if (!cursor || seen.has(cursor)) throw new ApiError('invalid_response'); seen.add(cursor); }
      } while (cursor !== null);
      return all;
    },
    async mutate(s: Session, w: Workout, deleted: boolean): Promise<Ack | null> {
      // Validate the outbound boundary as well as responses; never send an unrevisioned edit.
      authorized(s);
      if (w.remoteId !== undefined) { positive(w.remoteId); timestamp(w.revision); }
      else if (deleted || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(w.sourceRef ?? '')) throw new ApiError('request_failed');
      if (!deleted) {
        if (validateDraft(toDraft(w)) || (w.title && !WORKOUT_TYPES.some(t => t === w.title))) throw new ApiError('request_failed');
        intake(w.kcal); intake(w.proteinG);
        if (Boolean(w.startedAt) !== Boolean(w.finishedAt)) throw new ApiError('request_failed');
        if (w.startedAt && w.finishedAt) {
          timestamp(w.startedAt); timestamp(w.finishedAt);
          if (Date.parse(w.finishedAt) < Date.parse(w.startedAt)) throw new ApiError('request_failed');
        }
      }
      const path = `/v1/users/${s.userId}/workouts${w.remoteId ? `/${w.remoteId}` : ''}`;
      const body = deleted ? { expected_updated_at: w.revision } : { ...workoutBody(w), ...(w.remoteId ? { expected_updated_at: w.revision } : { source: 'mobile', source_ref: w.sourceRef }) };
      const value = await request(path, deleted ? 'DELETE' : w.remoteId ? 'PUT' : 'POST', body, s.token);
      if (deleted) { if (value !== null) throw new ApiError('invalid_response'); return null; }
      const v = record(value);
      if (typeof v.created !== 'boolean') throw new ApiError('invalid_response');
      return { workout_id: positive(v.workout_id), updated_at: timestamp(v.updated_at), created: v.created, new_exercises: array(v.new_exercises).map(text) };
    },
  };
}
export type Api = ReturnType<typeof createApi>;
