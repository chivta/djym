import { apiURL, ApiError, positive, record, text, timestamp } from './api.ts';
import type { Api, Login, Session } from './api.ts';
export const SESSION_KEY = 'djym.native.session';
export const LOGIN_KEY = 'djym.native.login';
export type Vault = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
function storedRecord(json: string): Record<string, unknown> {
  try { return record(JSON.parse(json)); } catch { throw new ApiError('invalid_response'); }
}
export function createAuth(base: string, api: Api, vault: Vault) {
  let generation = 0, polling = false, login: Login | null = null;
  let writes: Promise<void> = Promise.resolve();
  function write(action: () => Promise<void>) { const next = writes.then(action); writes = next.catch(() => {}); return next; }
  return {
    async restore(): Promise<{ session: Session | null; login: Login | null }> {
      const stored = await vault.get(SESSION_KEY), pending = await vault.get(LOGIN_KEY);
      let session: Session | null = null;
      if (stored) {
        const v = storedRecord(stored);
        const url = apiURL(text(v.apiURL));
        const token = text(v.token);
        if (!token || /\s/.test(token)) throw new ApiError('invalid_response');
        if (url === base) session = { apiURL: url, userId: positive(v.userId), token, expiresAt: timestamp(v.expiresAt) };
      }
      if (pending) {
        const v = storedRecord(pending);
        if (v.apiURL === base && Date.parse(timestamp(v.expires_at)) > Date.now()) {
          const nonce = text(v.nonce), bot = text(v.bot_url);
          if (!nonce || nonce.length > 128 || !/^https:\/\/t\.me\//.test(bot)) throw new ApiError('invalid_response');
          login = { nonce, bot_url: bot, expires_at: timestamp(v.expires_at) };
        }
      }
      return { session, login };
    },
    async start() {
      const g = ++generation;
      const next = await api.start();
      if (g !== generation) return null;
      await write(() => vault.set(LOGIN_KEY, JSON.stringify({ ...next, apiURL: base })));
      if (g !== generation) return null;
      login = next; return next;
    },
    async cancel() { generation++; login = null; await write(() => vault.remove(LOGIN_KEY)); },
    async poll(): Promise<Session | null> {
      if (!login || polling) return null;
      if (Date.parse(login.expires_at) <= Date.now()) { login = null; await write(() => vault.remove(LOGIN_KEY)); throw new ApiError('login_expired'); }
      const g = generation; polling = true;
      try {
        const session = await api.poll(login.nonce);
        if (!session || g !== generation) return null;
        await write(async () => {
          if (g !== generation) return;
          const previous = await vault.get(SESSION_KEY);
          try {
            await vault.set(SESSION_KEY, JSON.stringify(session));
            if (g === generation) await vault.remove(LOGIN_KEY);
          } finally {
            // Cancellation can happen during either asynchronous vault operation.
            if (g !== generation) {
              if (previous !== null) await vault.set(SESSION_KEY, previous); else await vault.remove(SESSION_KEY);
            }
          }
        });
        if (g !== generation) return null;
        login = null; return session;
      } finally { polling = false; }
    },
    async logout(session: Session | null) {
      generation++; login = null;
      await write(async () => { await vault.remove(SESSION_KEY); await vault.remove(LOGIN_KEY); });
      // The caller hides the account before this best-effort remote revoke.
      if (session) await api.logout(session);
    },
  };
}
