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
node --test scripts/android-release.test.mjs
npx expo install --check
npx expo export --platform all --max-workers 2
```

Tests use Node's native TypeScript support, test runner, and SQLite. They were run on Node 26.11.1. They cover validation, stored-data parsing, persistence across database reopen, stable-ID updates, same-day sessions, draft replacement, transaction rollback, discard, deletion, and history ordering. Tests exercise real SQLite through a small adapter; they do not exercise Expo's native bridge or render the UI.

Android and iOS JavaScript/Hermes bundle exports passed. No emulator or physical-device testing was performed.

The dependency audit reports 22 advisories in the Expo/React Native dependency tree, including development tooling. Its proposed fixes downgrade Expo and React Native to incompatible versions. No forced audit fix was applied. Run development servers only on trusted networks and recheck the audit before distributing the app.
