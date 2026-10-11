import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function releaseVersion(event, tag, configuredVersion, runNumber) {
  if (!['release', 'workflow_dispatch'].includes(event)) throw new Error('Unsupported build event');
  const versionName = event === 'release' ? (tag?.startsWith('v') ? tag.slice(1) : '') : configuredVersion;
  if (typeof versionName !== 'string' || !versionPattern.test(versionName) || versionName.trim() !== versionName || versionName.length > 100) {
    throw new Error('Expected version X.Y.Z with optional prerelease suffix (release tag must start with v)');
  }
  if (typeof runNumber !== 'string' || runNumber.trim() !== runNumber || !/^[1-9]\d*$/.test(runNumber) || !Number.isSafeInteger(Number(runNumber)) || Number(runNumber) > 2100000000) {
    throw new Error('Build run number must be an integer from 1 to 2100000000');
  }
  return { versionName, versionCode: Number(runNumber) };
}

const signingAnchor = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;
const releaseAnchor = `        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('Unexpected Expo Gradle template: missing or duplicate anchor');
  return source.replace(anchor, replacement);
}

export function configureReleaseGradle(source, { versionName, versionCode }) {
  // Only the inspected Expo 57 template is supported; template drift must stop the build.
  let result = replaceOnce(source, signingAnchor, signingAnchor.slice(0, -5) + `        release {
            storeFile file(requireSigningEnv('ANDROID_KEYSTORE_PATH'))
            storeType 'PKCS12'
            storePassword requireSigningEnv('ANDROID_KEYSTORE_PASSWORD')
            keyAlias requireSigningEnv('ANDROID_KEY_ALIAS')
            keyPassword requireSigningEnv('ANDROID_KEYSTORE_PASSWORD')
        }
    }`);
  result = replaceOnce(result, releaseAnchor, '        release {\n            signingConfig signingConfigs.release');
  const versionLines = result.match(/^        versionCode \d+\n        versionName "[^"\n]+"$/gm);
  if (versionLines?.length !== 1) throw new Error('Unexpected Expo Gradle version settings');
  result = replaceOnce(result, versionLines[0], `        versionCode ${versionCode}\n        versionName "${versionName}"`);
  return `// CI release signing: never fall back to the generated debug keystore.
def requireSigningEnv(String name) {
    def value = System.getenv(name)
    if (value == null || value.trim().isEmpty()) {
        throw new GradleException("Missing signing environment variable: " + name)
    }
    return value
}

` + result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
    const version = releaseVersion(process.env.GITHUB_EVENT_NAME, process.env.RELEASE_TAG, app.expo.version, process.env.GITHUB_RUN_NUMBER);
    const gradlePath = new URL('../android/app/build.gradle', import.meta.url);
    const gradle = configureReleaseGradle(readFileSync(gradlePath, 'utf8'), version);
    writeFileSync(gradlePath, gradle);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version.versionName}\n`);
    console.log(`Android release version ${version.versionName} (${version.versionCode})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Android release configuration failed');
    process.exitCode = 1;
  }
}
