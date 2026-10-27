export type TextSelection = { start: number; end: number };

export function insertAtSelection(current: string, selection: TextSelection, value: string) {
  const start = Math.max(0, Math.min(current.length, selection.start));
  const end = Math.max(start, Math.min(current.length, selection.end));
  const text = current.slice(0, start) + value + current.slice(end);
  const cursor = start + value.length;
  return { text, selection: { start: cursor, end: cursor } };
}

/** Guard a synchronous UI event against overlapping sends; the caller owns durable save/validation. */
export function sendOnce<T>(busy: { current: boolean }, send: () => T): T | undefined {
  if (busy.current) return undefined;
  busy.current = true;
  try { return send(); } finally { busy.current = false; }
}
