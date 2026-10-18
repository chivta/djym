# djym mobile

An offline-first workout log for Android and iOS, built with Expo and React Native. Sign in with the existing Telegram bot to load and edit account history. Workouts, programs and their independent drafts save to an account-isolated SQLite cache; pending writes sync when the app is active and connected.

## Run locally

```sh
cd mobile
npm ci
cp .example.env .env
# Replace EXPO_PUBLIC_API_URL with your development API base URL (including /api if proxied).
npm start
```

The API URL is required: invalid or missing configuration displays a setup error rather than silently selecting a server. Dotenv files stay ignored. Never put a bot secret or session token in the public environment. The Android release workflow supplies `EXPO_PUBLIC_API_URL=https://gymbro.chivtar.dev/api`; development and export commands must explicitly configure their own endpoint. A phone must be able to reach the configured API (localhost on the phone is not your development machine).

Open the QR code with a compatible Expo Go installation. Both the phone and development machine need to reach the development server to load the app. Workouts and drafts stay on the phone, not on the development machine.

For a native development build, use an Android SDK and emulator or connected device:

```sh
npm run android
```

On macOS with Xcode installed:

```sh
npm run ios
```

These commands generate ignored native projects and compile them. A release build with its bundled JavaScript runs without Metro. Initial sign-in and uncached history require connectivity; an existing cached account can log/edit offline. Development builds and Expo Go may need Metro to launch or reload. Browser support is not configured.

## Standalone Android releases

Publishing a GitHub Release runs `.github/workflows/android-release.yaml` at that release's tag. Tags must be `vX.Y.Z`, optionally followed by a safe prerelease suffix such as `v1.2.3-rc.1`. The workflow runs Expo prebuild and Gradle `:app:assembleRelease`, verifies the APK signature with `apksigner`, and uploads `djym-<version>.apk` and `djym-<version>.apk.sha256` to that exact Release. Rerunning a release build replaces those assets. The APK bundles the app and works without Metro; this is a universal, signed APK for direct installation, not a Play Store AAB. No EAS account is needed.

Before running it, a repository administrator must provision these GitHub Actions repository secrets:

- `ANDROID_KEYSTORE_BASE64`: base64-encoded production PKCS12 keystore.
- `ANDROID_KEYSTORE_PASSWORD`: the shared keystore and private-key password.
- `ANDROID_KEY_ALIAS`: the private-key alias in that keystore.

Keep the same production signing key across releases and back it up securely. The workflow decodes it into the runner's temporary directory, passes signing settings through environment reads (not generated Gradle properties or command-line passwords), and removes the decoded file even after failure. Missing secrets stop the build; CI never falls back to Expo's generated debug signer. Native Android projects remain generated and ignored, and local development commands are unchanged.

For a smoke build, choose **Actions → Android release → Run workflow** and select the branch or tag to build. This uses the version configured in `mobile/app.json` and uploads APK/checksum Actions artifacts, retained for 14 days; it does not create, publish, or change a GitHub Release. The selected ref must contain the workflow and release scripts. Both modes require the signing secrets.

Android `versionCode` uses this workflow's `github.run_number` (1–2100000000), so later workflow runs have increasing install versions. Rerunning the same run keeps its code. Do not replace/reset this workflow's run history if you need to preserve update ordering. With the same application ID (`com.djym.mobile`), stable signing key, and increasing versionCode, users can install an update over a previous release without uninstalling or losing the local workout database. An older build or differently signed development APK may not install as an update. Uninstalling or clearing app data erases the local log; Expo Go data is separate.

The release transformation intentionally rejects unexpected Expo Gradle template changes. After upgrading Expo, recheck the generated signing/version blocks and the focused tests before distributing another APK. GitHub-hosted runners supply the Android SDK; Java 17 follows the Expo 57 / React Native Gradle plugin's configured toolchain.

## Sign-in, import, and sync

Tap "Sign in with Telegram" to open the bot deep link. Confirm in Telegram and return to the app: polling only runs while active. Cancel or restart an expired request. Native session envelopes and pending login nonces are stored in Expo SecureStore, never in SQLite. No cookie authentication or shared bot secret is used.

After sign-in, all pages of history are cached. Cached history appears immediately on later starts. Manual "Sync / retry", foreground resume, local mutations, and a bounded foreground retry interval trigger sync. A failed full fetch never replaces history with an empty list. A revoked/expired session prompts sign-in but keeps edits. Sign-out hides the account immediately, clears its secure credentials, and attempts server revocation; offline revocation can fail, and the server session then lasts until its expiry. Signing back into the same API URL/user restores pending changes; a different user or endpoint cannot see them.

The SQLite v1 migration retains old local workouts and the old draft as **unassigned** data. "Import old local data" asks for confirmation naming the target account and API endpoint. It atomically moves those records into that account and queues saves. Original free workout names remain names, not notes; recognized legacy types are retained separately. An existing account draft blocks import without changing either dataset: finish/discard it first.

Remote edits/deletes use the stored exact `updated_at` revision. A conflict or remote deletion retains the local change and shows "Reload server version". This confirmed action fetches the newest record and discards the local change (or removes the copy if the server deleted it); there is no force-overwrite action. Creates use a stable UUID `source_ref`, even after lost acknowledgments. An in-flight create deleted locally finishes its idempotent create before issuing its durable delete. Newer local edits cannot be cleared by older acknowledgments, and old-account responses are invalidated after account/token changes.

## Log a workout

Tap "Log a workout", enter the date as YYYY-MM-DD, optionally enter a free workout name and notes, and add exercises. Each set records kg and reps. Use 0 kg for no external weight. "Add set" creates an empty planned row and never copies completed reps. Only one exercise can be expanded at a time; collapsed rows show terse set previews. History uses compact dark message bubbles with date, name and intake headers.

Edits save immediately to a local SQLite draft. Back returns to history without discarding it. After restarting the app, tap "Resume draft" to continue. A failed draft write shows a retry action; keep the app open until the draft saves.

"Save workout" validates all entries, saves the workout, and clears its draft in one transaction. Tap a saved workout to inspect or edit it. Re-saving updates that workout rather than creating a duplicate. Several workouts can share a date. Discarding an edit keeps the previously saved workout unchanged. Deletion requires confirmation.

Dates are calendar dates, weights have at most two decimal places from 0 to 9999.99 kg, and reps are whole numbers from 1 to 9999. Exercise names are free text. Names and sets keep their order. Historical empty entries/sets stay empty. Historical intake and timestamps are preserved even though the minimal editor does not expose controls for them; source identity never changes when editing. A dot or comma works as the weight's decimal separator.

## Programs and suggestions

Open **Programs** from history to create, edit or delete templates. Each program has a nonblank free name and 1–100 ordered named exercises. Use up/down controls to reorder them. Each entry plans 1–100 sets with optional target reps (1–9999); names have a 2000-character limit. Empty rep targets serialize as null. Program drafts persist independently of the workout draft. Back keeps the draft; discard and deletion require confirmation. Deleting or renaming a program never changes previous workouts.

Workout names match programs after trimming, collapsing whitespace and ignoring case. Matching exercises appear grey with an explicit add action. Accepted exercises show planned rows. Weight placeholders come from the latest earlier matching workout calendar day containing usable sets for the same exercise (written or canonical name); additional sets use the last weight. Same-day/future workouts, the current workout and local deletions are excluded. With no history the weight hint is 0 kg.

Entering reps accepts the grey weight unless a weight is already entered. Target reps remain grey placeholders, never completed work. Untouched suggested exercises and planned rows are not saved as work. Partially entered rows fail validation rather than disappearing. Entered values persist across collapse, restart, and workout-name/program changes.

Program cache, drafts and durable outbox are isolated by API URL/user. Program sync shares the existing foreground sequence: login, resume, mutations and manual refresh trigger it. Failed fetches keep the cache, creates reuse stable UUIDs, updates/deletes require exact revisions, and older acknowledgments cannot clear newer edits. Conflicts remain sticky until a confirmed server reload; DELETE 404 completes deletion. Switching accounts invalidates old responses. Programs contain no prescribed weights.

## Storage and limits

SQLite schema v3 stores JSON workout/program records, independent account-specific drafts, and durable mutation generations/tombstones in `djym.db`. Cache isolation is by normalized API URL and user ID. The previous v1 tables remain available until explicit import. Small synchronous writes complete before another edit or save can run. Startup rejects malformed records or an unsupported schema without resetting the log.

There is no background sync worker, export, or application-level database encryption. Pending changes only sync in the foreground. SecureStore credentials are separate from the cache; reinstall/OS restore behavior varies by platform. Clearing app data or uninstalling can erase the log. Expo Go stores the database inside its own app data. Workouts created there do not automatically transfer to a standalone installation.

## Verification

```sh
npm run typecheck
npm test
node --test scripts/android-release.test.mjs
EXPO_NO_DOTENV=1 EXPO_OFFLINE=1 npx expo install --check
EXPO_NO_DOTENV=1 EXPO_PUBLIC_API_URL=http://127.0.0.1:49199 npx expo export --platform android --max-workers 2
EXPO_NO_DOTENV=1 EXPO_PUBLIC_API_URL=http://127.0.0.1:49199 npx expo export --platform ios --max-workers 2
```

Tests use Node's native TypeScript support, test runner, and SQLite. They were run on Node 26.11.1. They cover validation, stored-data parsing, persistence across database reopen, stable-ID updates, same-day sessions, draft replacement, transaction rollback, discard, deletion, and history ordering. Additional controlled fake-fetch tests cover v1 migration/import rollback, account/API isolation, all-page fetches, metadata, historical empty sets, create idempotency, outbox rollback, in-flight edit/delete acknowledgments, conflict reload, 401/expiry, logout invalidation, and secure-login cancellation. Program tests also cover domain limits, free-name DTO fallback/legacy metadata, history selection and materialization, v2/v3 migration, isolated program drafts, rollback, restart/retries, late acknowledgments, tombstones, sticky conflicts and guarded server reloads. Tests exercise real Node SQLite through a small adapter; they do not exercise Expo's native bridge or render the UI.

Android and iOS JavaScript/Hermes bundle exports passed. Integration also built and installed a distinct `com.djym.mobile.local` debug APK on the dedicated Android 36 emulator. Generated/ignored native settings and an explicit loopback API URL kept this separate from production installs; dotenv was disabled. Required Android NDK/CMake packages were installed with user approval, without dependency upgrades. Compatibility validation used installed Expo tooling in offline mode (which warns that offline dependency validation is less reliable).

Local verification used the actual TypeScript API adapter against a dedicated loopback API/PostgreSQL 17 database: program CRUD, identical/differing replays, stale revisions, account isolation, free workout names, metadata preservation and legacy bot-name fallback passed. ADB interaction checked program creation/edit/deletion, case/whitespace name matching, single expanded exercise, grey weight/target placeholders, reps accepting 60 kg, save/reopen with only the entered 60 kg × 9 set, and untouched suggestions remaining absent. Offline workout/program writes survived app restart and synced after reconnection; signing into a second dummy account showed neither the first account's history nor programs. Dummy sign-in used only real local auth endpoints through an external local confirmation harness, not a committed bypass or real Telegram confirmation. Screenshots and runtime details are kept outside Git in the integration handoff. The app was left open on a Push draft with program suggestions.

The dependency audit reports 22 advisories in the Expo/React Native dependency tree, including development tooling. Its proposed fixes downgrade Expo and React Native to incompatible versions. No forced audit fix was applied. Run development servers only on trusted networks and recheck the audit before distributing the app.
