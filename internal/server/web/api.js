export class HTTPError extends Error {
  constructor(status, code) {
    super(`HTTP ${status}: ${code}`);
    this.status = status;
  }
}
export async function request(path, method = "GET", body) {
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers:
        method === "GET"
          ? {}
          : { "Content-Type": "application/json", "X-Gymbro-Write": "1" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    if (!response.ok) {
      let code = response.statusText;
      try {
        code = (await response.json()).error || code;
      } catch {}
      throw new HTTPError(response.status, code);
    }
    return response.status === 204 ? null : await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
export async function allWorkouts(account) {
  const rows = [],
    seen = new Set();
  let cursor = null;
  do {
    const page = await request(
      `/v1/users/${account}/workouts?limit=100${cursor ? "&before=" + encodeURIComponent(cursor) : ""}`,
    );
    rows.push(...(page.workouts || []));
    cursor = page.next_cursor;
    if (cursor && seen.has(cursor))
      throw new Error(
        "Server repeated a history cursor; reconciliation stopped.",
      );
    seen.add(cursor);
  } while (cursor);
  return rows;
}
