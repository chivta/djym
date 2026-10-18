import { createStore } from './storage.ts';
import type { Database } from './storage.ts';
import { parseProgram, validateProgram } from './programs.ts';
import type { Program } from './programs.ts';

export type ProgramRow = { program: Program; generation: number; pending: boolean; deleted: boolean; submitted: boolean; error: string };
function storedProgram(payload: string, draft = false): Program {
  try {
    const p: unknown = JSON.parse(payload);
    if (!draft) {
      const value = p as Program;
      if (!value.updated_at) {
        if (validateProgram(value)) throw new Error();
        return value;
      }
      return parseProgram(value);
    }
    const value = p as Program;
    if (!value || typeof value.id !== 'string' || typeof value.name !== 'string' || !Array.isArray(value.entries) ||
      value.entries.some(e => !e || typeof e.name !== 'string' || typeof e.set_count !== 'number' ||
        (e.target_reps !== null && typeof e.target_reps !== 'number')) ||
      (value.updated_at !== undefined && typeof value.updated_at !== 'string')) throw new Error();
    return value;
  } catch { throw new Error('invalid_storage'); }
}
export function createProgramStore(db: Database, account: string) {
  createStore(db);
  function rows(): ProgramRow[] {
    return db.getAllSync<{ payload: string; generation: number; pending: number; deleted: number; submitted: number; error: string }>('SELECT * FROM account_programs WHERE account = ? ORDER BY rowid;', account).map(r => ({
      program: storedProgram(r.payload), generation: r.generation, pending: !!r.pending, deleted: !!r.deleted, submitted: !!r.submitted, error: r.error,
    }));
  }
  function put(r: ProgramRow) {
    db.runSync(`INSERT INTO account_programs (account,id,payload,generation,pending,deleted,submitted,error) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(account,id) DO UPDATE SET payload=excluded.payload,generation=excluded.generation,pending=excluded.pending,
      deleted=excluded.deleted,submitted=excluded.submitted,error=excluded.error;`, account, r.program.id, JSON.stringify(r.program), r.generation, +r.pending, +r.deleted, +r.submitted, r.error);
  }
  function erase(id: string) { db.runSync('DELETE FROM account_programs WHERE account = ? AND id = ?;', account, id); }
  function draft(): Program | null {
    const r = db.getFirstSync<{ payload: string }>('SELECT payload FROM program_drafts WHERE account = ?;', account);
    return r ? storedProgram(r.payload, true) : null;
  }
  function writeDraft(p: Program) { db.runSync('INSERT INTO program_drafts (account,payload) VALUES (?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload;', account, JSON.stringify(p)); }
  function clearDraft() { db.runSync('DELETE FROM program_drafts WHERE account = ?;', account); }
  return {
    rows, draft, writeDraft, clearDraft,
    load() { return rows().filter(r => !r.deleted).map(r => r.program).sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)); },
    save(p: Program) {
      if (validateProgram(p)) throw new Error('invalid_program');
      db.withTransactionSync(() => {
        const r = rows().find(r => r.program.id === p.id);
        put({ program: { ...p, updated_at: r?.program.updated_at ?? p.updated_at }, generation: (r?.generation ?? 0) + 1, pending: true, deleted: false, submitted: r?.submitted ?? false, error: r?.error ?? '' });
        clearDraft();
      });
    },
    remove(id: string) {
      db.withTransactionSync(() => {
        const r = rows().find(r => r.program.id === id);
        if (r) {
          if (!r.program.updated_at && !r.submitted) erase(id);
          else put({ ...r, generation: r.generation + 1, deleted: true, pending: true });
        }
        if (draft()?.id === id) clearDraft();
      });
    },
    submitted(id: string) { const r = rows().find(r => r.program.id === id); if (r) put({ ...r, submitted: true }); },
    acknowledge(snapshot: ProgramRow, ack: Program | null) {
      db.withTransactionSync(() => {
        const r = rows().find(r => r.program.id === snapshot.program.id);
        if (!r) return;
        if (!ack) { if (r.deleted && r.generation === snapshot.generation) erase(r.program.id); return; }
        put({ ...r, program: { ...r.program, updated_at: ack.updated_at }, pending: r.generation !== snapshot.generation || r.deleted, error: r.error });
        const d = draft(); if (d?.id === r.program.id) writeDraft({ ...d, updated_at: ack.updated_at });
      });
    },
    failure(snapshot: ProgramRow, error: string) { const r = rows().find(r => r.program.id === snapshot.program.id); if (r) put({ ...r, error }); },
    merge(programs: Program[]) {
      db.withTransactionSync(() => {
        const draftId = draft()?.id;
        for (const p of programs) {
          const r = rows().find(r => r.program.id === p.id);
          if (!r?.pending && p.id !== draftId) put({ program: p, generation: r?.generation ?? 0, pending: false, deleted: false, submitted: true, error: '' });
        }
        for (const r of rows()) if (!r.pending && r.program.id !== draftId && !programs.some(p => p.id === r.program.id)) erase(r.program.id);
      });
    },
    resolve(id: string, server: Program | null) {
      db.withTransactionSync(() => {
        const r = rows().find(r => r.program.id === id);
        if (!r) return;
        if (server) put({ program: server, generation: r.generation + 1, pending: false, deleted: false, submitted: true, error: '' });
        else erase(id);
        if (draft()?.id === id) clearDraft();
      });
    },
  };
}
export type ProgramStore = ReturnType<typeof createProgramStore>;
