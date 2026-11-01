import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const program = readFileSync(new URL("./program.txt", import.meta.url), "utf8");
const note = "03.10.2026 Upper\nBench 60-10 -9";
const revision = "2026-10-03T12:00:00.123456Z";
async function saved(page, account = "guest") {
  return page.evaluate(
    async (account) => (await import("/db.js")).readAccount(account),
    account,
  );
}
async function ready(page) {
  await expect(page.locator("#save-status")).toHaveText("Draft saved locally");
}
async function complete(page, text = note) {
  await page.locator("#editor").fill(text);
  await ready(page);
  await page.locator("#complete").click();
  await expect(page.locator("#snapshot")).toHaveText(text);
}
async function mock(
  context,
  {
    user = null,
    post = "success",
    put = "success",
    del = "success",
    pagination = false,
  } = {},
) {
  const state = {
    user,
    post,
    put,
    del,
    rows: [],
    programs: [],
    writes: [],
    pages: [],
    gate: null,
  };
  await context.route("**/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/me")
      return route.fulfill({
        status: state.user ? 200 : 401,
        json: state.user ? { user_id: state.user } : { error: "unauthorized" },
      });
    if (path === "/auth/logout") {
      state.user = null;
      return route.fulfill({ status: 204 });
    }
    if (path === "/auth/telegram/login")
      return route.fulfill({
        json: {
          bot_url: "https://t.me/test_bot?start=test",
          expires_at: new Date(Date.now() + 600000).toISOString(),
        },
      });
    if (path === "/auth/telegram/poll") {
      state.user = state.user || 1;
      return route.fulfill({
        json: { status: "confirmed", user_id: state.user },
      });
    }
    return route.fulfill({ status: 404 });
  });
  await context.route("**/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      method = req.method();
    if (
      !state.user ||
      !url.pathname.startsWith("/v1/users/" + state.user + "/")
    )
      return route.fulfill({ status: 403, json: { error: "forbidden" } });
    if (method === "GET") {
      if (url.pathname.endsWith("/programs"))
        return route.fulfill({ json: { programs: state.programs } });
      state.pages.push(url.search);
      if (pagination && state.rows.length)
        return route.fulfill({
          json: url.searchParams.has("before")
            ? { workouts: state.rows, next_cursor: null }
            : { workouts: [], next_cursor: "opaque-page-2" },
        });
      return route.fulfill({
        json: { workouts: state.rows, next_cursor: null },
      });
    }
    expect(req.headers()["content-type"]).toBe("application/json");
    expect(req.headers()["x-gymbro-write"]).toBe("1");
    expect(req.headers().authorization).toBeUndefined();
    const body = req.postDataJSON();
    state.writes.push({ method, path: url.pathname, body });
    const behavior =
      method === "POST" ? state.post : method === "PUT" ? state.put : state.del;
    if (state.gate) await state.gate;
    if (behavior === "loss") return route.abort("failed");
    if (typeof behavior === "number")
      return route.fulfill({
        status: behavior,
        json: { error: behavior === 400 ? "invalid_request" : "unauthorized" },
      });
    if (url.pathname.includes("/programs")) {
      const row = {
        id: body.id || url.pathname.split("/").at(-1),
        name: body.name,
        entries: body.entries,
        updated_at: revision,
      };
      state.programs = state.programs.filter((p) => p.id !== row.id);
      state.programs.push(row);
      return route.fulfill({ status: 201, json: row });
    }
    if (method === "DELETE") {
      state.rows = state.rows.filter(
        (r) => String(r.id) !== url.pathname.split("/").at(-1),
      );
      return route.fulfill({ status: 204 });
    }
    const id =
      method === "POST"
        ? state.rows.length + 1
        : Number(url.pathname.split("/").at(-1));
    const row = {
      ...body,
      id,
      updated_at: revision,
      source: body.source || "mobile",
      source_ref:
        body.source_ref || state.rows.find((r) => r.id === id)?.source_ref,
      entries: body.entries.map((e) => ({
        name_as_written: e.name,
        exercise: e.name,
        sets: e.sets,
      })),
    };
    state.rows = state.rows.filter((r) => r.id !== id);
    state.rows.push(row);
    return route.fulfill({
      status: method === "POST" ? 201 : 200,
      json: {
        workout_id: id,
        updated_at: revision,
        created: method === "POST",
        new_exercises: [],
      },
    });
  });
  return state;
}

test("guest import, suggestions, durable edits/times, mobile geometry and offline cold reload", async ({
  page,
  context,
}) => {
  const api = await mock(context),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await ready(page);
  await page.locator("#import-toggle").click();
  await page.locator("#program-input").fill(program);
  await page.locator("#import-form button[type=submit]").click();
  await expect(page.locator("#sync-summary")).toContainText("5 program days");
  let s = await saved(page);
  expect(s.programs.reduce((n, p) => n + p.entries.length, 0)).toBe(47);
  expect(s.records).toEqual([]);
  await page.locator("#editor").fill("03.10.2026 Upper\nIncl");
  await page.locator("#editor").focus();
  await expect(page.locator("#ghost")).toHaveText(
    "ine Smith/dumbbell press — 3×6–8",
  );
  await page.locator("#editor").press("Tab");
  await page.locator("#complete").click();
  await expect(page.locator("#time-error")).toContainText("planned ranges");
  expect((await saved(page)).records).toHaveLength(0);
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator("#editor").fill("03.10.2026 Upper\n");
    await page.locator("#editor").focus();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    const geometry = await page.evaluate(() => {
      const e = document.querySelector("#editor"),
        m = document.querySelector("#mirror-text");
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("#ghost"));
      const rect = range.getClientRects()[0],
        style = getComputedStyle(e);
      return [
        e.getBoundingClientRect().width,
        m.getBoundingClientRect().width,
        style.font,
        getComputedStyle(m).font,
        rect.top -
          (e.getBoundingClientRect().top +
            parseFloat(style.paddingTop) +
            parseFloat(style.lineHeight)),
        rect.left -
          (e.getBoundingClientRect().left + parseFloat(style.paddingLeft)),
      ];
    });
    expect(geometry[0]).toBe(geometry[1]);
    expect(geometry[2]).toBe(geometry[3]);
    expect(Math.abs(geometry[4])).toBeLessThan(8);
    expect(Math.abs(geometry[5])).toBeLessThan(1);
    await page.screenshot({
      path: `test-results/djym-${width}.png`,
      fullPage: true,
    });
  }
  await page.locator("#editor").fill(note);
  await page.locator("#workout-times").evaluate((e) => (e.open = true));
  await page.locator("#started-at").fill("2026-10-03T23:30");
  await page.locator("#complete").click();
  await expect(page.locator("#time-error")).toContainText(
    "both start and finish",
  );
  await page.locator("#completed-at").fill("2026-10-04T00:15");
  await ready(page);
  await page.reload();
  await ready(page);
  expect(await page.locator("#started-at").inputValue()).toBe(
    "2026-10-03T23:30",
  );
  await page.locator("#complete").click();
  await expect(page.locator("#detail-times")).toContainText("2026-10-04 00:15");
  const original = (await saved(page)).records[0];
  await page.locator("#new-workout").click();
  await page
    .locator("#editor")
    .fill("01.02.2020 pending draft\nleave untouched");
  await ready(page);
  await page.locator("#history-toggle").click();
  await page.locator(".record").click();
  await page.locator("#edit-again").click();
  await page.locator("#editor").fill("03.10.2026 Revised\nBench 61-9");
  await ready(page);
  expect((await saved(page)).records[0].text).toBe(note);
  await page.reload();
  await ready(page);
  await page.locator("#cancel-edit").click();
  expect((await saved(page)).records[0].id).toBe(original.id);
  await page.locator("#edit-again").click();
  await page.locator("#editor").fill("03.10.2026 Revised\nBench 61-9");
  await ready(page);
  await page.locator("#complete").click();
  await expect(page.locator("#snapshot")).toContainText("Revised");
  s = await saved(page);
  expect(s.records).toHaveLength(1);
  expect(s.records[0].id).toBe(original.id);
  expect(s.draft.text).toContain("pending draft");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await ready(page);
  await expect(page.locator("#editor")).toHaveValue(
    "01.02.2020 pending draft\nleave untouched",
  );
  const cacheURLs = await page.evaluate(async () => {
    const keys = await caches.keys();
    return (
      await Promise.all(
        keys.map(async (key) =>
          (await (await caches.open(key)).keys()).map(
            (r) => new URL(r.url).pathname,
          ),
        ),
      )
    ).flat();
  });
  expect(
    cacheURLs.every(
      (url) => !url.startsWith("/v1") && !url.startsWith("/auth"),
    ),
  ).toBe(true);
  expect(api.writes).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("Telegram cookie login, explicit guest adoption, five program range POSTs, account isolation", async ({
  page,
  context,
}) => {
  const api = await mock(context);
  await page.goto("/");
  await ready(page);
  await complete(page);
  await page.locator("#login").click();
  await expect(page.locator("#bot-link")).toHaveAttribute(
    "href",
    /^https:\/\/t.me\//,
  );
  await expect(page.locator("#account-label")).toContainText("Account 1");
  expect(api.writes).toHaveLength(0);
  expect((await saved(page, "1")).records).toHaveLength(0);
  await page.locator("#import-toggle").click();
  await page.locator("#program-input").fill(program);
  await page.locator("#import-form button[type=submit]").click();
  await expect
    .poll(() => api.writes.filter((w) => w.path.endsWith("/programs")).length)
    .toBe(5);
  for (const write of api.writes) {
    expect(write.body.entries[0].target_reps_min).toBeGreaterThan(0);
    expect(write.body.entries[0].target_reps_max).toBeGreaterThan(0);
  }
  page.once("dialog", (d) => d.accept());
  await page.locator("#adopt").click();
  await expect
    .poll(() => api.writes.filter((w) => w.path.endsWith("/workouts")).length)
    .toBe(1);
  await expect
    .poll(async () => Object.keys((await saved(page, "1")).outbox).length)
    .toBe(0);
  expect((await saved(page)).records).toHaveLength(0);
  expect((await saved(page, "1")).records[0].revision).toBe(revision);
  await page.locator("#logout").click();
  await expect(page.locator("#account-label")).toContainText("Guest");
  api.user = 2;
  api.rows = [];
  api.programs = [];
  await page.locator("#login").click();
  await expect(page.locator("#account-label")).toContainText("Account 2");
  expect((await saved(page, "2")).records).toHaveLength(0);
  expect((await saved(page, "1")).records).toHaveLength(1);
});

test("uncertain POST is durable, never blindly retried, reconciles source_ref across every page", async ({
  page,
  context,
}) => {
  const api = await mock(context, { user: 1, post: "loss", pagination: true });
  await page.goto("/");
  await expect(page.locator("#account-label")).toContainText("Account 1");
  await complete(page);
  await expect
    .poll(async () => Object.values((await saved(page, "1")).outbox)[0]?.status)
    .toBe("uncertain");
  expect(api.writes).toHaveLength(1);
  const attempt = api.writes[0].body;
  expect(attempt.source).toBe("mobile");
  expect(attempt.source_ref).toMatch(/^[0-9a-f-]{36}$/);
  await page.reload();
  await ready(page);
  await page.locator("#sync").click();
  await expect(page.locator("#sync")).toBeEnabled();
  expect(api.writes).toHaveLength(1);
  api.rows = [
    {
      ...attempt,
      id: 77,
      updated_at: revision,
      entries: attempt.entries.map((e) => ({
        name_as_written: e.name,
        sets: e.sets,
      })),
    },
  ];
  await page.locator("#sync").click();
  await expect
    .poll(async () => Object.keys((await saved(page, "1")).outbox).length)
    .toBe(0);
  expect((await saved(page, "1")).records[0].serverID).toBe(77);
  expect(api.pages.some((q) => q.includes("opaque-page-2"))).toBe(true);
  expect(api.writes).toHaveLength(1);
});

test("slow create acknowledgement never overwrites newer edit; next operation is same-ID PUT", async ({
  page,
  context,
}) => {
  const api = await mock(context, { user: 1 });
  let release;
  api.gate = new Promise((resolve) => (release = resolve));
  await page.goto("/");
  await expect(page.locator("#account-label")).toContainText("Account 1");
  await complete(page);
  await expect.poll(() => api.writes.length).toBe(1);
  await page.locator("#edit-again").click();
  const edited = "03.10.2026 Upper\nBench 61-11";
  await page.locator("#editor").fill(edited);
  await ready(page);
  await page.locator("#complete").click();
  await expect(page.locator("#snapshot")).toHaveText(edited);
  api.gate = null;
  release();
  await expect
    .poll(
      async () => Object.values((await saved(page, "1")).outbox)[0]?.operation,
    )
    .toBe("update");
  expect((await saved(page, "1")).records[0].text).toBe(edited);
  await expect(page.locator("#sync")).toBeEnabled();
  await page.locator("#sync").click();
  await expect.poll(() => api.writes.length).toBe(2);
  expect(api.writes[1].method).toBe("PUT");
  expect(api.writes[1].path).toMatch(/\/workouts\/1$/);
  expect(api.writes[1].body.source).toBeUndefined();
});

test("tab crash sending recovery and multiple matches never create again; export retains content", async ({
  page,
  context,
}) => {
  const api = await mock(context, { user: 1 });
  await page.goto("/");
  await expect(page.locator("#account-label")).toContainText("Account 1");
  await page.evaluate(async (note) => {
    const db = await import("/db.js"),
      d = await import("/domain.js");
    await db.mutate("1", (s) => {
      const r = { id: d.uuid(), text: note, date: "2026-10-03", version: 1 };
      s.records.push(r);
      s.outbox[r.id] = {
        kind: "workout",
        operation: "create",
        status: "sending",
        attempt: d.uuid(),
        version: 1,
        payload: {
          ...d.workoutPayload(r),
          source: "mobile",
          source_ref: d.uuid(),
        },
      };
    });
  }, note);
  await page.reload();
  await ready(page);
  await expect
    .poll(async () => Object.values((await saved(page, "1")).outbox)[0]?.status)
    .toBe("uncertain");
  expect(api.writes).toHaveLength(0);
  const attempt = Object.values((await saved(page, "1")).outbox)[0].payload;
  api.rows = [1, 2].map((id) => ({
    ...attempt,
    id,
    updated_at: revision,
    entries: attempt.entries.map((e) => ({
      name_as_written: e.name,
      sets: e.sets,
    })),
  }));
  await page.locator("#sync").click();
  await expect
    .poll(async () => Object.values((await saved(page, "1")).outbox)[0]?.status)
    .toBe("conflict");
  expect(api.writes).toHaveLength(0);
  const download = page.waitForEvent("download");
  await page.locator("#export").click();
  expect((await download).suggestedFilename()).toContain("djym-1-");
  expect((await saved(page, "1")).records.some((r) => r.text === note)).toBe(
    true,
  );
});

for (const fallback of [false, true])
  test(`two tabs serialize sender with ${fallback ? "IndexedDB lease" : "Web Locks"}`, async ({
    page,
    context,
  }) => {
    if (fallback)
      await context.addInitScript(() =>
        Object.defineProperty(navigator, "locks", { value: undefined }),
      );
    const api = await mock(context, { user: 1 });
    await page.goto("/");
    await expect(page.locator("#account-label")).toContainText("Account 1");
    await expect
      .poll(async () => (await saved(page, "1")).lastSync)
      .toBeTruthy();
    await expect(page.locator("#sync")).toBeEnabled();
    const previousSync = (await saved(page, "1")).lastSync;
    const second = await context.newPage();
    await second.goto("/");
    await expect(second.locator("#account-label")).toContainText("Account 1");
    await expect
      .poll(async () => (await saved(page, "1")).lastSync)
      .not.toBe(previousSync);
    await expect(second.locator("#sync")).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const db = await (await import("/db.js")).openDB();
          return new Promise((resolve) => {
            const r = db.transaction("meta").objectStore("meta").get("sender");
            r.onsuccess = () => resolve(Boolean(r.result));
          });
        }),
      )
      .toBe(false);
    await page.evaluate(async (note) => {
      const db = await import("/db.js"),
        d = await import("/domain.js");
      await db.mutate("1", (s) => {
        const r = { id: d.uuid(), text: note, date: "2026-10-03", version: 1 };
        s.records.push(r);
        db.queueRecord(s, r);
      });
    }, note);
    const results = await Promise.all([
      page.evaluate(async () => {
        return await (await import("/sync.js")).syncAccount("1");
      }),
      second.evaluate(async () => {
        return await (await import("/sync.js")).syncAccount("1");
      }),
    ]);
    expect(
      api.writes.filter((w) => w.method === "POST"),
      JSON.stringify({ results, state: await saved(page, "1") }),
    ).toHaveLength(1);
    expect(Object.keys((await saved(page, "1")).outbox)).toHaveLength(0);
  });

test("storage transaction failure is visible; old data and unfinished draft remain", async ({
  page,
  context,
}) => {
  await mock(context);
  await page.goto("/");
  await ready(page);
  const before = (await saved(page)).draft.text;
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    window.restoreTransactions = () =>
      (IDBDatabase.prototype.transaction = original);
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    };
  });
  await page.locator("#editor").fill(note);
  await expect(page.locator("#storage-notice")).toContainText(
    "transaction failed",
  );
  expect((await saved(page)).draft.text).toBe(before);
  expect((await saved(page)).records).toHaveLength(0);
  await page.evaluate(() => window.restoreTransactions());
  await page.locator("#complete").click();
  await expect(page.locator("#storage-notice")).toContainText("Draft changed");
});

test("one-time prototype migration retains untouched raw key and never uploads legacy records", async ({
  page,
  context,
}) => {
  const legacy = {
      draft: { text: "03.10.2026 Legacy\nBench 20-10" },
      records: [{ id: "old", text: note, date: "2026-10-03" }],
      programs: [],
    },
    raw = JSON.stringify(legacy);
  await context.addInitScript((raw) => {
    if (!localStorage.getItem("fieldnotes-prototype-v1"))
      localStorage.setItem("fieldnotes-prototype-v1", raw);
  }, raw);
  const api = await mock(context);
  await page.goto("/");
  await ready(page);
  expect((await saved(page)).records).toHaveLength(1);
  await page.reload();
  await ready(page);
  expect((await saved(page)).records).toHaveLength(1);
  expect(
    await page.evaluate(() => localStorage.getItem("fieldnotes-prototype-v1")),
  ).toBe(raw);
  expect(api.writes).toHaveLength(0);
});

for (const [status, expected] of [
  [400, "blocked"],
  [401, "queued"],
  [503, "uncertain"],
])
  test(`HTTP ${status} retains content with ${expected} state`, async ({
    page,
    context,
  }) => {
    const api = await mock(context, { user: 1, post: status });
    await page.goto("/");
    await expect(page.locator("#account-label")).toContainText("Account 1");
    await complete(page);
    await expect.poll(() => api.writes.length).toBe(1);
    await expect
      .poll(
        async () => Object.values((await saved(page, "1")).outbox)[0]?.status,
      )
      .toBe(expected);
    expect((await saved(page, "1")).records[0].text).toBe(note);
    expect(api.writes).toHaveLength(1);
    await page.reload();
    await ready(page);
    if (status === 503) {
      await expect(page.locator("#sync")).toBeEnabled();
      await page.locator("#sync").click();
      await expect(page.locator("#sync")).toBeEnabled();
      expect(api.writes).toHaveLength(1);
    }
    if (status === 400) {
      await page.locator("#history-toggle").click();
      await page.locator(".record").click();
      api.post = "success";
      page.once("dialog", (d) => d.accept());
      await page.locator("#retry").click();
      await expect
        .poll(async () => Object.keys((await saved(page, "1")).outbox).length)
        .toBe(0);
    }
  });

test("uncertain PUT and DELETE stay durable and visible without blind retry", async ({
  page,
  context,
}) => {
  const api = await mock(context, { user: 1 });
  await page.goto("/");
  await expect(page.locator("#account-label")).toContainText("Account 1");
  await complete(page);
  await expect
    .poll(async () => Object.keys((await saved(page, "1")).outbox).length)
    .toBe(0);
  api.put = "loss";
  await page.locator("#edit-again").click();
  await complete(page, "03.10.2026 Upper\nBench 65-8");
  await expect
    .poll(async () => Object.values((await saved(page, "1")).outbox)[0]?.status)
    .toBe("uncertain");
  await expect(page.locator("#sync")).toBeEnabled();
  await page.locator("#sync").click();
  await expect(page.locator("#sync")).toBeEnabled();
  expect(api.writes.filter((w) => w.method === "PUT")).toHaveLength(1);
  expect((await saved(page, "1")).records[0].text).toContain("65-8");
  // The server now confirms that exact replacement (simulate lost response).
  const item = Object.values((await saved(page, "1")).outbox)[0];
  api.rows = [
    {
      ...item.payload,
      id: 1,
      source: "mobile",
      source_ref: api.rows[0].source_ref,
      updated_at: revision,
      entries: item.payload.entries.map((e) => ({
        name_as_written: e.name,
        sets: e.sets,
      })),
    },
  ];
  await page.locator("#sync").click();
  await expect
    .poll(async () => Object.keys((await saved(page, "1")).outbox).length)
    .toBe(0);
  api.del = "loss";
  page.once("dialog", (d) => d.accept());
  await page.locator("#delete-record").click();
  await expect
    .poll(async () => Object.values((await saved(page, "1")).outbox)[0]?.status)
    .toBe("uncertain");
  await expect(page.locator(".record")).toContainText("pending deletion");
  await page.locator(".record").click();
  await expect(page.locator("#retry")).toBeVisible();
  await page.locator("#sync").click();
  await expect(page.locator("#sync")).toBeEnabled();
  expect(api.writes.filter((w) => w.method === "DELETE")).toHaveLength(1);
  api.rows = [];
  await page.locator("#sync").click();
  await expect
    .poll(async () => (await saved(page, "1")).records.length)
    .toBe(0);
});

test("offline known-unsent create edits coalesce and delete cancels without dispatch", async ({
  page,
  context,
}) => {
  const api = await mock(context, { user: 1 });
  await page.goto("/");
  await expect(page.locator("#account-label")).toContainText("Account 1");
  await expect.poll(async () => (await saved(page, "1")).lastSync).toBeTruthy();
  await expect(page.locator("#sync")).toBeEnabled();
  await context.setOffline(true);
  await complete(page);
  const id = (await saved(page, "1")).records[0].id;
  await page.locator("#edit-again").click();
  await complete(page, "03.10.2026 Upper\nBench 70-7");
  let state = await saved(page, "1");
  expect(state.records[0].id).toBe(id);
  expect(Object.keys(state.outbox)).toHaveLength(1);
  expect(Object.values(state.outbox)[0].operation).toBe("create");
  page.once("dialog", (d) => d.accept());
  await page.locator("#delete-record").click();
  await expect
    .poll(async () => (await saved(page, "1")).records.length)
    .toBe(0);
  state = await saved(page, "1");
  expect(state.outbox).toEqual({});
  await context.setOffline(false);
  await expect(page.locator("#sync")).toBeEnabled();
  expect(api.writes).toHaveLength(0);
});

test("known remote workout change is flagged, program opaque revision survives reimport", async ({
  page,
  context,
}) => {
  const api = await mock(context, { user: 1 });
  await page.goto("/");
  await expect(page.locator("#account-label")).toContainText("Account 1");
  await complete(page);
  await expect
    .poll(async () => Object.keys((await saved(page, "1")).outbox).length)
    .toBe(0);
  api.rows[0].updated_at = "2026-10-03T12:00:00.123457Z";
  api.rows[0].raw_text = "03.10.2026 remote\nBench 99-1";
  await page.locator("#edit-again").click();
  await complete(page, "03.10.2026 local\nBench 61-9");
  await expect
    .poll(async () => Object.values((await saved(page, "1")).outbox)[0]?.status)
    .toBe("conflict");
  expect(api.writes.filter((w) => w.method === "PUT")).toHaveLength(0);
  for (let i = 0; i < 2; i++) {
    await page.locator("#import-toggle").click();
    await page.locator("#program-input").fill(program);
    await page.locator("#import-form button[type=submit]").click();
    await expect
      .poll(() => api.writes.filter((w) => w.path.includes("/programs")).length)
      .toBe((i + 1) * 5);
    await expect(page.locator("#sync")).toBeEnabled();
  }
  const puts = api.writes.filter((w) => w.method === "PUT");
  expect(puts).toHaveLength(5);
  for (const write of puts)
    expect(write.body.expected_updated_at).toBe(revision);
});

test("corrupt legacy key remains untouched, cross-origin prototype JSON can restore locally", async ({
  page,
  context,
}) => {
  const raw = "{broken";
  await context.addInitScript(
    (raw) => localStorage.setItem("fieldnotes-prototype-v1", raw),
    raw,
  );
  const api = await mock(context);
  await page.goto("/");
  await ready(page);
  await expect(page.locator("#storage-notice")).toContainText(
    "original key left untouched",
  );
  const legacy = {
    draft: { text: "draft" },
    records: [{ id: "from-other-origin", text: note, date: "2026-10-03" }],
    programs: [],
  };
  page.once("dialog", (d) => d.accept());
  await page.locator("#backup-input").setInputFiles({
    name: "prototype-export.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(legacy)),
  });
  await expect.poll(async () => (await saved(page)).records.length).toBe(1);
  expect(
    await page.evaluate(() => localStorage.getItem("fieldnotes-prototype-v1")),
  ).toBe(raw);
  expect(api.writes).toHaveLength(0);
});

test("slow authentication/cache refresh does not replace the live draft", async ({
  page,
  context,
}) => {
  await mock(context, { user: 1 });
  await page.goto("/");
  await expect.poll(async () => (await saved(page, "1")).lastSync).toBeTruthy();
  await expect(page.locator("#sync")).toBeEnabled();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await context.route("**/auth/me", async (route) => {
    await gate;
    await route.fulfill({ json: { user_id: 1 } });
  });
  await page.locator("#sync").click();
  await page.locator("#editor").fill(note);
  await ready(page);
  release();
  await expect(page.locator("#sync")).toBeEnabled();
  await expect(page.locator("#editor")).toHaveValue(note);
  await page.locator("#complete").click();
  await expect(page.locator("#snapshot")).toHaveText(note);
});

test("slow DELETE acknowledgement preserves a newer local edit without recreating", async ({
  page,
  context,
}) => {
  const api = await mock(context, { user: 1 });
  await page.goto("/");
  await expect(page.locator("#account-label")).toContainText("Account 1");
  await complete(page);
  await expect
    .poll(async () => Object.keys((await saved(page, "1")).outbox).length)
    .toBe(0);
  let release;
  api.gate = new Promise((resolve) => (release = resolve));
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#delete-record").click();
  await expect
    .poll(() => api.writes.filter((w) => w.method === "DELETE").length)
    .toBe(1);
  await page.evaluate(async () => {
    const db = await import("/db.js");
    await db.mutate("1", (state) => {
      state.records[0].text = "03.10.2026 Newer edit\nBench 70-8";
      state.records[0].version++;
    });
  });
  api.gate = null;
  release();
  await expect
    .poll(async () => Object.keys((await saved(page, "1")).outbox).length)
    .toBe(0);
  const record = (await saved(page, "1")).records[0];
  expect(record.text).toContain("Newer edit");
  expect(record.localOnly).toBe(true);
  expect(record.serverID).toBeUndefined();
  expect(api.writes.filter((w) => w.method === "POST")).toHaveLength(1);
});

test("ghost tap and right-swipe acceptance preserve typed characters and ignore IME/selection", async ({
  page,
  context,
}) => {
  await mock(context);
  await page.goto("/");
  await ready(page);
  await page.locator("#import-toggle").click();
  await page.locator("#program-input").fill(program);
  await page.locator("#import-form button[type=submit]").click();
  await expect(page.locator("#import-dialog")).not.toBeVisible();
  const editor = page.locator("#editor"),
    prefix = "03.10.2026 Upper\nIncl";
  await editor.fill(prefix);
  await editor.focus();
  await expect(page.locator("#accept")).toBeVisible();
  await page.locator("#accept").click();
  await expect(editor).toHaveValue(prefix + "ine Smith/dumbbell press — 3×6–8");
  await editor.fill(prefix);
  await editor.dispatchEvent("compositionstart");
  await expect(page.locator("#ghost")).toHaveText("");
  await editor.dispatchEvent("compositionend");
  await expect(page.locator("#ghost")).not.toHaveText("");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const point = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#ghost"));
    const r = range.getClientRects()[0];
    return { x: r.left + 4, y: r.top + r.height / 2 };
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point],
  });
  for (let i = 1; i <= 5; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: point.x + 16 * i, y: point.y }],
    });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(editor).toHaveValue(prefix + "ine Smith/dumbbell press — 3×6–8");
  await editor.fill(prefix);
  await editor.evaluate((el) => {
    el.setSelectionRange(0, 2);
    el.dispatchEvent(new Event("select"));
  });
  await expect(page.locator("#ghost")).toHaveText("");
});

test("a broadcast cannot retarget a rendered new draft to another tab’s edit", async ({
  page,
  context,
}) => {
  await mock(context);
  await page.goto("/");
  await ready(page);
  const original = "03.10.2026 Existing W\nBench 20-10",
    draft = "04.10.2026 New draft\nSquat 50-8";
  await page.evaluate(
    async ({ original, draft }) => {
      const db = await import("/db.js");
      await db.mutate("guest", (s) => {
        s.records = [
          { id: "W", text: original, date: "2026-10-03", version: 1 },
        ];
        s.draft = { id: "new-draft", text: draft };
      });
    },
    { original, draft },
  );
  await page.reload();
  await ready(page);
  const second = await context.newPage();
  await second.goto("/");
  await ready(second);
  await second.locator("#history-toggle").click();
  await second.locator(".record").click();
  await second.locator("#edit-again").click();
  await expect(page.locator("#editor-conflict")).toBeVisible();
  await expect(page.locator("#editor")).toHaveValue(draft);
  await expect(page.locator("#editor")).toHaveAttribute("readonly", "");
  await expect(page.locator("#complete")).toBeDisabled();
  await expect(page.locator("#complete")).toHaveText("Complete workout");
  await page.locator("#editor").focus();
  await page.locator("#editor").pressSequentially("NOT W");
  await page.evaluate(() => document.querySelector("#complete").onclick());
  await expect(page.locator("#storage-notice")).toContainText("Editor changed");
  let state = await saved(page);
  expect(state.records[0].text).toBe(original);
  expect(state.edit.draft.text).toBe(original);
  expect(state.draft.text).toBe(draft);
  await second.locator("#cancel-edit").click();
  await expect(page.locator("#editor-conflict")).not.toBeVisible();
  await expect(page.locator("#complete")).toBeEnabled();
  await second.locator("#edit-again").click();
  await expect(page.locator("#editor-conflict")).toBeVisible();
  const edited = "03.10.2026 Existing W\nBench 21-9";
  await complete(second, edited);
  await expect(page.locator("#editor-conflict")).not.toBeVisible();
  await expect(page.locator("#editor")).toHaveValue(draft);
  await page.locator("#complete").click();
  await expect(page.locator("#snapshot")).toHaveText(draft);
  state = await saved(page);
  expect(state.records).toHaveLength(2);
  expect(state.records.find((r) => r.id === "W").text).toBe(edited);
});

test("cancel/reopen and account transitions invalidate stale rendered edit actions", async ({
  page,
  context,
}) => {
  await mock(context);
  await page.goto("/");
  await ready(page);
  await complete(page);
  await page.locator("#new-workout").click();
  const draft = "04.10.2026 Suspended\nSquat 50-8";
  await page.locator("#editor").fill(draft);
  await ready(page);
  await page.locator("#history-toggle").click();
  await page.locator(".record").click();
  await page.locator("#edit-again").click();
  const second = await context.newPage();
  await second.goto("/");
  await ready(second);
  await second.locator("#cancel-edit").click();
  await expect(page.locator("#editor-conflict")).toBeVisible();
  await expect(page.locator("#cancel-edit")).toBeDisabled();
  await expect(page.locator("#complete")).toHaveText("Save changes");
  // Cancel/reopen the SAME record creates a different edit session, not an ABA match.
  await second.locator("#edit-again").click();
  await expect(second.locator("#edit-banner")).toBeVisible();
  await expect(page.locator("#editor-conflict")).toBeVisible();
  await page.evaluate(() => {
    document.querySelector("#cancel-edit").onclick();
    document.querySelector("#complete").onclick();
  });
  await expect(page.locator("#storage-notice")).toContainText("Editor changed");
  expect((await saved(page)).edit).toBeTruthy();
  expect((await saved(page)).records[0].text).toBe(note);
  await page.locator("#review-editor").click();
  await expect(page.locator("#editor-conflict")).not.toBeVisible();
  await expect(page.locator("#editor")).toHaveValue(note);
  await second.locator("#cancel-edit").click();
  await expect(page.locator("#editor-conflict")).toBeVisible();
  await page.locator("#review-editor").click();
  await expect(page.locator("#editor")).toHaveValue(draft);
  await expect(page.locator("#complete")).toHaveText("Complete workout");
  await second.evaluate(async () => {
    await (await import("/db.js")).setActive("2");
  });
  await expect(page.locator("#account-label")).toContainText("Account 2");
  expect(await page.locator("#editor").inputValue()).not.toBe(draft);
  expect((await saved(page, "2")).records).toHaveLength(0);
  expect((await saved(page)).draft.text).toBe(draft);
  expect((await saved(page)).records[0].text).toBe(note);
});

test("historical yearless edit suggestions use saved year and exclude the edited record", async ({
  page,
  context,
}) => {
  await mock(context);
  await page.goto("/");
  await ready(page);
  await page.evaluate(async () => {
    await (
      await import("/db.js")
    ).mutate("guest", (s) => {
      s.records = [
        {
          id: "self-2018",
          date: "2018-05-02",
          text: "02.05 Upper\nBench 88-1",
          version: 1,
        },
        {
          id: "future-2019",
          date: "2019-05-01",
          text: "01.05.2019 Upper\nBench 99-1",
          version: 1,
        },
        {
          id: "prior-2017",
          date: "2017-05-01",
          text: "01.05.2017 Upper\nBench 20-10",
          version: 1,
        },
      ];
    });
  });
  await page.reload();
  await ready(page);
  await page.locator("#history-toggle").click();
  await page.locator(".record").filter({ hasText: "2 May 2018" }).click();
  await page.locator("#edit-again").click();
  await page.locator("#editor").fill("02.05 Upper\nBench");
  await page.locator("#editor").focus();
  await expect(page.locator("#ghost")).toHaveText(" 20-10");
  await expect(page.locator("#suggestion-source")).toContainText("1 May 2017");
  await page.evaluate(async () => {
    await (
      await import("/db.js")
    ).mutate("guest", (s) => {
      s.records = s.records.filter((r) => r.id !== "prior-2017");
    });
    const channel = new BroadcastChannel("djym-state");
    channel.postMessage("changed");
    channel.close();
  });
  await expect(page.locator("#ghost")).toHaveText("");
  await page.locator("#editor").fill("03.05 Upper\nBench");
  await expect(page.locator("#ghost")).toHaveText("");
  await complete(page, "02.05 Upper\nBench 21-9");
  expect(
    (await saved(page)).records.find((r) => r.id === "self-2018").date,
  ).toBe("2018-05-02");
});

test("app writes and the committed sending attempt request strict durability", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "locks", { value: undefined });
    window.writeOptions = [];
    window.sendingCommitted = false;
    const transaction = IDBDatabase.prototype.transaction,
      put = IDBObjectStore.prototype.put;
    IDBDatabase.prototype.transaction = function (...args) {
      if (args[1] === "readwrite")
        window.writeOptions.push(args[2]?.durability);
      return transaction.apply(this, args);
    };
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (
        value?.outbox &&
        Object.values(value.outbox).some((item) => item.status === "sending")
      ) {
        window.sendingDurability = this.transaction.durability;
        this.transaction.addEventListener("complete", () => {
          window.sendingCommitted = true;
        });
      }
      return put.call(this, value, ...args);
    };
  });
  const api = await mock(context, { user: 1 });
  let release;
  api.gate = new Promise((resolve) => (release = resolve));
  await page.goto("/");
  await expect(page.locator("#account-label")).toContainText("Account 1");
  await complete(page);
  await expect.poll(() => api.writes.length).toBe(1);
  const proof = await page.evaluate(() => ({
    options: window.writeOptions,
    sendingDurability: window.sendingDurability,
    committed: window.sendingCommitted,
  }));
  expect(proof.options.length).toBeGreaterThan(2);
  expect(proof.options.every((option) => option === "strict")).toBe(true);
  expect(proof.sendingDurability).toBe("strict");
  expect(proof.committed).toBe(true);
  api.gate = null;
  release();
  await expect
    .poll(async () => Object.keys((await saved(page, "1")).outbox).length)
    .toBe(0);
});

for (const behavior of ["ignored", "throws"])
  test(`unsupported strict durability (${behavior}) never falls back or dispatches`, async ({
    page,
    context,
  }) => {
    const api = await mock(context, { user: 1 });
    await page.goto("/");
    await expect
      .poll(async () => (await saved(page, "1")).lastSync)
      .toBeTruthy();
    await expect(page.locator("#sync")).toBeEnabled();
    await page.evaluate(
      async ({ note, behavior }) => {
        const db = await import("/db.js");
        await db.mutate("1", (s) => {
          const record = {
            id: "strict-pending",
            text: note,
            date: "2026-10-03",
            version: 1,
          };
          s.records.push(record);
          db.queueRecord(s, record);
        });
        const original = IDBDatabase.prototype.transaction;
        window.attemptedWriteOptions = [];
        IDBDatabase.prototype.transaction = function (...args) {
          if (args[1] === "readwrite") {
            window.attemptedWriteOptions.push(args[2]?.durability);
            if (behavior === "throws")
              throw new TypeError("options unsupported");
            return original.call(this, args[0], args[1]);
          }
          return original.apply(this, args);
        };
      },
      { note, behavior },
    );
    await page.locator("#sync").click();
    await expect(page.locator("#storage-notice")).toContainText(
      "Strict IndexedDB durability is unavailable",
    );
    expect(api.writes).toHaveLength(0);
    const state = await saved(page, "1");
    expect(state.records[0].text).toBe(note);
    expect(state.outbox["strict-pending"].status).toBe("queued");
    const attempts = await page.evaluate(() => window.attemptedWriteOptions);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((option) => option === "strict")).toBe(true);
    const download = page.waitForEvent("download");
    await page.locator("#export").click();
    expect((await download).suggestedFilename()).toContain("djym-1-");
  });

test("a rejected pre-broadcast autosave exports its unsaved buffer before explicit editor review", async ({
  page,
  context,
}) => {
  await mock(context);
  await page.goto("/");
  await ready(page);
  await complete(page);
  await page.locator("#new-workout").click();
  const draft = "04.10.2026 New draft\nSquat 50-8",
    unsaved = "04.10.2026 Unsaved draft\nSquat 51-7";
  await page.locator("#editor").fill(draft);
  await ready(page);
  // Delay delivery so typing races a committed edit transition, not just its UI notice.
  await page.evaluate(async () => {
    const { changes } = await import("/db.js");
    const handler = changes.onmessage;
    changes.onmessage = () => {};
    window.deliverEditorBroadcast = () => handler();
  });
  const second = await context.newPage();
  await second.goto("/");
  await ready(second);
  await second.locator("#history-toggle").click();
  await second.locator(".record").click();
  await second.locator("#edit-again").click();
  await expect(second.locator("#edit-banner")).toBeVisible();
  await page.locator("#editor").fill(unsaved);
  await expect(page.locator("#save-status")).toHaveText("Not saved");
  expect((await saved(page)).draft.text).toBe(draft);
  expect((await saved(page)).edit.draft.text).toBe(note);
  await page.evaluate(() => window.deliverEditorBroadcast());
  await expect(page.locator("#editor-conflict")).toBeVisible();
  await expect(page.locator("#editor")).toHaveValue(unsaved);
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#review-editor").click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("djym-unsaved-editor.json");
  const recovered = JSON.parse(readFileSync(await download.path(), "utf8"));
  expect(recovered.draft.text).toBe(unsaved);
  expect(recovered.targetId).toBe(null);
  await expect(page.locator("#editor")).toHaveValue(note);
  await expect(page.locator("#complete")).toHaveText("Save changes");
  expect((await saved(page)).records[0].text).toBe(note);
});
