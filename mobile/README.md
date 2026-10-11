# djym mobile

A local-only workout log for Android and iOS, built with Expo and React Native. The existing Go API, Telegram bot, and web app remain separate. This app does not sign in, call the API, or sync workouts.

## Run locally

```sh
cd mobile
npm ci
npm start
```

Open the QR code with a compatible Expo Go installation. Both the phone and development machine need to reach the development server to load the app. Workouts and drafts stay on the phone, not on the development machine.

For a native development build, use an Android SDK and emulator or connected device:

```sh
npm run android
```

On macOS with Xcode installed:

```sh
npm run ios
```

These commands generate ignored native projects and compile them. A release build with its bundled JavaScript runs without Metro or an internet connection. Development builds and Expo Go may need Metro to launch or reload. Browser support is not configured.

## Log a workout

Tap "Log a workout", enter the date as YYYY-MM-DD, and add exercises. Each set records kg and reps. Use 0 kg for no external weight. "Add set" copies the previous set's values.

Edits save immediately to a local SQLite draft. Back returns to history without discarding it. After restarting the app, tap "Resume draft" to continue. A failed draft write shows a retry action; keep the app open until the draft saves.

"Save workout" validates all entries, saves the workout, and clears its draft in one transaction. Tap a saved workout to inspect or edit it. Re-saving updates that workout rather than creating a duplicate. Several workouts can share a date. Discarding an edit keeps the previously saved workout unchanged. Deletion requires confirmation.

Dates are calendar dates, weights have at most two decimal places from 0 to 9999.99 kg, and reps are whole numbers from 1 to 9999. Exercise names are free text. Names and sets keep their order. A dot or comma works as the weight's decimal separator.

## Storage and limits

SQLite stores normalized workout records and one draft as JSON in `djym.db`. Small synchronous writes complete before another edit or save can run. Startup rejects malformed records or an unsupported schema without resetting the log.

There is no sync, export, backup, or application-level database encryption. Clearing app data or uninstalling can erase the log. Expo Go stores the database inside its own app data. Workouts created there do not automatically transfer to a standalone installation.

## Verification

```sh
npm run typecheck
npm test
npx expo install --check
npx expo export --platform all --max-workers 2
```

Tests use Node's native TypeScript support, test runner, and SQLite. They were run on Node 26.11.1. They cover validation, stored-data parsing, persistence across database reopen, stable-ID updates, same-day sessions, draft replacement, transaction rollback, discard, deletion, and history ordering. Tests exercise real SQLite through a small adapter; they do not exercise Expo's native bridge or render the UI.

Android and iOS JavaScript/Hermes bundle exports passed. No emulator or physical-device testing was performed.

The dependency audit reports 22 advisories in the Expo/React Native dependency tree, including development tooling. Its proposed fixes downgrade Expo and React Native to incompatible versions. No forced audit fix was applied. Run development servers only on trusted networks and recheck the audit before distributing the app.
