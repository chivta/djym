import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configureReleaseGradle, releaseVersion } from './android-release.mjs';

const template = readFileSync(new URL('./fixtures/expo57-release.gradle', import.meta.url), 'utf8');

test('releaseVersion derives release version and safe Android versionCode', () => {
  assert.deepEqual(releaseVersion('release', 'v2.3.4-rc.1', '1.0.0', '42'), {
    versionName: '2.3.4-rc.1', versionCode: 42,
  });
  assert.deepEqual(releaseVersion('workflow_dispatch', undefined, '1.0.0', '2100000000'), {
    versionName: '1.0.0', versionCode: 2100000000,
  });
});

test('releaseVersion rejects unsafe tags, events, and run numbers', () => {
  for (const tag of [undefined, '1.2.3', 'v01.2.3', 'v1.2', 'v1.2.3+', 'v1.2.3-../bad', 'v1.2.3\n', 'v1.2.3"', 'v1.2.3-$(id)']) {
    assert.throws(() => releaseVersion('release', tag, '1.0.0', '1'));
  }
  for (const run of [undefined, '', '0', '-1', '1.1', '01', '2100000001', '9007199254740993']) {
    assert.throws(() => releaseVersion('release', 'v1.0.0', '1.0.0', run));
  }
  assert.throws(() => releaseVersion('push', 'v1.0.0', '1.0.0', '1'));
  assert.throws(() => releaseVersion('workflow_dispatch', undefined, 'bad', '1'));
});

test('configureReleaseGradle replaces only release signing and version, with environment reads', () => {
  const result = configureReleaseGradle(template, releaseVersion('release', 'v2.3.4-rc.1', '1.0.0', '42'));
  assert.match(result, /versionCode 42\n        versionName "2\.3\.4-rc\.1"/);
  assert.match(result, /release \{\n            signingConfig signingConfigs\.release/);
  assert.match(result, /debug \{\n            signingConfig signingConfigs\.debug/);
  assert.match(result, /storeFile file\('debug.keystore'\)/);
  assert.match(result, /storeType 'PKCS12'/);
  for (const name of ['ANDROID_KEYSTORE_PATH', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS']) {
    assert.ok(result.includes(`requireSigningEnv('${name}')`));
  }
  assert.match(result, /System.getenv\(name\)/);
  assert.match(result, /throw new GradleException/);
  assert.equal((result.match(/signingConfig signingConfigs.debug/g) ?? []).length, 1);
  assert.ok(result.includes('minifyEnabled enableMinifyInReleaseBuilds'));
});

test('configureReleaseGradle fails closed on template drift, duplicate anchors, or repeated patching', () => {
  const version = releaseVersion('release', 'v1.0.0', '1.0.0', '1');
  for (const source of [
    template.replace("storePassword 'android'", "storePassword 'changed'"),
    template.replace('signingConfig signingConfigs.debug\n            def enableShrinkResources', 'signingConfig signingConfigs.other\n            def enableShrinkResources'),
    template.replace('versionCode 1', 'versionCode unknown'),
    template + template,
    configureReleaseGradle(template, version),
  ]) {
    assert.throws(() => configureReleaseGradle(source, version), /Unexpected Expo Gradle/);
  }
});
