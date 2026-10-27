import { applyWorkoutMessage } from './workoutMessage.ts';
import type { Draft } from './model.ts';

export type TextSelection = { start: number; end: number };

export function insertAtSelection(current: string, selection: TextSelection, value: string) {
  const start = Math.max(0, Math.min(current.length, selection.start));
  const end = Math.max(start, Math.min(current.length, selection.end));
  const text = current.slice(0, start) + value + current.slice(end);
  const cursor = start + value.length;
  return { text, selection: { start: cursor, end: cursor } };
}

/** Guard a synchronous UI event against overlapping sends; the caller owns durable save/validation. */
export function createChatMessageHandlers(options: {
  current(): Draft | null;
  setCurrent(draft: Draft | null): void;
  createDraft(): Draft;
  writeDraft(draft: Draft): void;
  saveDraft(draft: Draft): void;
  onSaved?(): void;
  onIssue?(message: string): void;
}) {
  return {
    onText(text: string): boolean {
      const next = { ...(options.current() ?? options.createDraft()), messageText: text };
      options.setCurrent(next);
      try { options.writeDraft(next); return true; } catch { return false; }
    },
    onSend(text: string): boolean {
      const parsed = applyWorkoutMessage(text, options.current() ?? options.createDraft());
      if (!parsed.ok) {
        options.onIssue?.(`${parsed.issue.text}${parsed.issue.token ? `: ${parsed.issue.token}` : ''}`);
        return false;
      }
      try {
        options.saveDraft(parsed.draft);
        options.setCurrent(null);
        options.onSaved?.();
        return true;
      } catch { return false; }
    },
  };
}

export function sendOnce<T>(busy: { current: boolean }, send: () => T): T | undefined {
  if (busy.current) return undefined;
  busy.current = true;
  try { return send(); } finally { busy.current = false; }
}
