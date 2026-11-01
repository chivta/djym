# djym web app

The Go API binary serves djym at `/`. It embeds the public vanilla ES modules,
HTML/CSS, manifest, icons and root-scoped service worker. No frontend build,
external CDN, bot/service secret, bearer-token storage, or Node runtime is needed
in production. The approved `docs/prototype/` remains a reference, not runtime.

## Use

- Start a note with `DD.MM.YYYY any title` (yearless notes use the current year;
  edits keep the saved year). Each exercise line uses actual `weight-reps` sets:
  `Bench 60-10 -9 50-12`. `-20` at the start means bodyweight, recorded as weight
  `0`; subsequent `-reps` repeat the previous weight. Weights allow at most two
  decimals and must fit `0..9999.99`. Invalid dates/sets never silently change.
- A draft autosaves locally; only **Complete workout** creates a completed record.
  Start/finish times are optional together. Incomplete times can stay in a draft.
  Times are local wall-clock inputs converted to RFC3339; nonexistent DST times
  are rejected, ambiguous fall-back times use the browser's earlier offset.
- Import multi-day text (`Day 1 — Upper`, `Exercise — 3×6–8`). The five-day,
  47-exercise reference imports as five ordered programs. Unicode separators,
  slash-containing literal exercise names and inclusive rep ranges are retained.
  Reimport replaces matching normalized full titles. Import parses completely
  before committing; server upload is per day, not an atomic batch. Pending/error
  counts are shown, and failed program sync can be explicitly resolved.
- Program matching uses normalized full titles or an **unambiguous** short title
  (`Upper` for `Day 1 — Upper`). Ghost exercise/target/prior actual-set text is
  offered at the end of the textarea only. Accept with Tab, tap **Accept**, or a
  short right swipe starting over the ghost. Suggestions never enter the note
  until accepted. Prior actual sets are scoped to the same title/exercise and a
  strictly earlier day. Historical yearless edits use their saved workout year and
  never suggest their own completed record. Planned `3×6–8` lines are suggestions, not fabricated sets:
  replace them with actual sets or remove them before completion.
- History **Edit workout** suspends the new-workout draft, preserves the same
  record/server ID and autosaves only the edit draft. **Save changes** replaces
  the completed record; **Cancel edit** leaves it unchanged and resumes the draft.
  Each rendered editor is bound to its account and draft/edit session. If another
  tab opens, cancels or saves a different edit, the stale editor freezes rather
  than silently retargeting input or completion. **Review editor changes** switches
  its visible text and actions together. Any unsaved buffer is downloaded as
  `djym-unsaved-editor.json` before replacement; keep that recovery file (it is a
  manual text/time recovery artifact, not a normal restore backup).

## Local storage, accounts and sync

IndexedDB `djym-v1` transactionally stores per-account drafts, suspended edits,
completed records, program caches and an outbox. Storage errors are visible;
there is no memory-only success fallback. Every application write requests
`{durability: "strict"}` and verifies the transaction reports `strict`, including
immutable sending attempts and the fallback sender lease. Dispatch waits for that
strict transaction's completion. Engines that reject or silently ignore the
option are **read-only**: local writes and automatic sync stop with an explicit
error, while existing partitions remain readable/exportable. There is no relaxed
fallback. This relies on the browser/OS implementing the IndexedDB strict-durability
contract; it is not a guarantee against faulty hardware or browser bugs, and no
power-loss experiment is claimed. Browser/device storage is not a backup:
use **Export backup**, especially before resolving uncertain operations. Browser
storage can be evicted or cleared by the user; no app can prevent that.

Guest use stays local. **Sign in with Telegram** starts the same-origin cookie
flow; open the returned Telegram link, confirm with the bot and return to the app.
The foreground app polls and obtains an HttpOnly session cookie. It never knows
or ships the bot/service secret. Writes use JSON and `X-Gymbro-Write: 1`.
Signing in selects that account's separate partition. Guest records/programs
upload **only** after explicit **Adopt guest records**. Guest drafts remain in the
guest partition. Signing out selects guest storage; cached accounts remain on the
device, not visible in another account's UI. This is account separation, not
at-rest encryption or protection against someone with browser developer tools.

Sync runs in the foreground on authenticated startup/login, online events,
completion/import, and **Sync**. Keep the app open until it finishes. There is no
Background Sync dependency. Web Locks serialize senders across tabs; browsers
without Web Locks use a renewed transactional IndexedDB lease. Durable sending
attempts recovered after interruption are treated as uncertain, never as unsent.
A lease-busy tab schedules another foreground drain for known-unsent work.

Ordinary workout POST is **not idempotent**: every POST creates a new row. A
mobile-source UUID `source_ref` is provenance, not a replay key. The app persists
an immutable payload/attempt **before dispatch**. Network loss, timeout, ambiguous
server failure or a crashed sending tab leaves a durable **uncertain** operation.
An uncertain workout POST is never automatically sent again. **Sync** scans all
paginated server history: one matching mobile source reference links the ID;
multiple matches are a conflict; no matches stays uncertain (absence is not proof
that a request cannot still commit). Queued creates that were never dispatched
can safely coalesce edits, or be canceled by deletion.

Uncertain PUT/DELETE are also retained, not blindly retried. A matching server
projection or confirmed absence can reconcile them; otherwise review is required.
History shows pending deletion tombstones so their export/retry/keep-local actions
remain accessible. A newer edit survives a slow create/replace acknowledgement.
An edit concurrent with successful deletion is retained locally rather than
silently recreated. Explicit resolution can keep content local, retry a rejected
write, or deliberately issue a **new** create after a duplicate-risk warning.
Export first and review server history before that last option.

**Cross-device workout updates/deletes are unconditional, last-write-wins.** A
cached revision comparison can flag a *known* remote change, but a GET followed by
PUT/DELETE is **not atomic conflict protection**. Another client can still edit
between those requests; neither the UI nor the API prevents that race. Program
revision tokens are opaque strings and programs retain their existing server
revision checks and UUID-create replay behavior.

## Prototype migration and restore

On the same origin, `fieldnotes-prototype-v1` is copied into guest IndexedDB once,
with a transactionally committed migration marker/raw backup. The original
localStorage key is **never rewritten or removed**, even when corrupt. Real
records, draft, suspended edit and imported programs are preserved. Demo fixtures
are not seeded or uploaded. Invalid old actual text remains editable locally and
must validate before upload.

Different scheme, host or port means a different origin; automatic access is
impossible (including moving HTTP to HTTPS). On the old prototype origin export
the original key in browser developer tools, without changing it:

```js
const a = document.createElement('a');
a.href = URL.createObjectURL(new Blob([
  localStorage.getItem('fieldnotes-prototype-v1')
], {type: 'application/json'}));
a.download = 'djym-prototype.json';
a.click();
```

Choose that file with **Restore backup** on the new origin. Native djym JSON
backups restore through the same control. Restores are additive, guest/local-only,
with fresh local IDs; they do **not** replay original outbox attempts or retain
server linkage. Re-adopting restored previously-synced records can create duplicates;
review first. Export includes unresolved payloads for manual investigation.

## Development and installation

Existing `docker compose up -d api postgres` exposes the real local API/app at
**http://10.10.0.2:8090/** when `PORT=8090`; PostgreSQL remains on the private
Compose network. Use `COOKIE_SECURE=false` only for local HTTP. The Air watcher
watches Go/SQL, not web assets: restart the local API after changing embedded
HTML/JS/CSS (`docker compose restart api`). Do not start/restart the bot for web
work. No test writes should target the developer database.

**LAN HTTP is not a secure context.** The app can save local notes and use the
HTTP API there, but a phone cannot register a service worker/install the PWA at
that URL. Real phone installation needs a same-origin HTTPS endpoint with a
certificate trusted by that phone, and `COOKIE_SECURE=true`. Set up/approve that
TLS ingress separately; this change does not deploy certificates or touch a live
server. Do not use insecure-browser flags as installation evidence. On iOS use
Safari's Add to Home Screen; other browsers' installation UX varies.

The service worker's explicit allowlist caches **only public shell assets**. It
never intercepts `/auth`, `/v1`, Swagger or other paths, nor caches user responses.
Unknown API paths are not HTML fallbacks. A first successful online shell visit is
needed before offline cold reload. Bump `CACHE` in `web/sw.js` whenever shipping
changed shell assets; worker activation removes only older djym shell caches,
never IndexedDB. There is no fallback to the prototype or demo data.

## Reproducible checks

Node is test tooling only. Playwright is pinned in `package-lock.json`.

```sh
npm ci --ignore-scripts
npm test
npx playwright install --with-deps chromium
npm run test:browser
# Optional installed Chromium instead of a Playwright download:
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser
go vet ./...
go test ./... -count=1
```

Browser tests start a **loopback-only**, public-shell test server on localhost:8092
and mock browser-cookie API requests. `localhost` is a browser-trusted local origin
without bypass flags; tests exercise real service workers and IndexedDB, offline
cold reload, mobile screenshots, imports, edits/times, auth/account switching,
uncertain operations, paginated reconciliation, multi-tab sending and aborted
storage transactions. Test fixtures/tooling are outside the embedded assets.
`DJYM_TEST_URL=http://localhost:8093` can run the same suite against an isolated
embedded release server (API calls remain mocked). Never point tests at live data.
Screenshots are written to ignored `test-results/`; CI uploads them for review.
Opt-in PostgreSQL Go integration tests require an isolated localhost database named
`gymbro_mobile_test` via `GYMBRO_TEST_DATABASE_URL`; ordinary `go test` skips them
if the environment variable is absent. No live Telegram sign-in or phone TLS /
installation has been claimed by these automated tests.
