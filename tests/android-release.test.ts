/// <reference types="node" />
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('release signing requires complete external credentials and rejects a debug or checkout key', async t => {
  const builder = await import('../scripts/build-android-artifact.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'weave-release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = join(dir, 'release.jks');
  writeFileSync(key, 'isolated configuration fixture');
  const env = {
    WEAVE_ANDROID_KEYSTORE: key,
    WEAVE_ANDROID_KEY_ALIAS: 'weave-release',
    WEAVE_ANDROID_STORE_PASSWORD: 'fixture-store-secret',
    WEAVE_ANDROID_KEY_PASSWORD: 'fixture-key-secret',
    WEAVE_ANDROID_CERT_SHA256: 'a'.repeat(64),
  };
  assert.equal(builder.validatedSigningEnvironment(env).keystorePath, key);
  assert.throws(() => builder.validatedSigningEnvironment({ ...env, WEAVE_ANDROID_STORE_PASSWORD: '' }), /WEAVE_ANDROID_STORE_PASSWORD/);
  assert.throws(() => builder.validatedSigningEnvironment({ ...env, WEAVE_ANDROID_KEY_ALIAS: 'androiddebugkey' }), /debug/i);
  const alias = join(dir, 'checkout-key.jks');
  symlinkSync(resolve('package.json'), alias);
  assert.throws(() => builder.validatedSigningEnvironment({ ...env, WEAVE_ANDROID_KEYSTORE: alias }), /outside/i);
});

test('release artifact verification fences debug signing, certificate drift, stale native versions and package IDs', async () => {
  const builder = await import('../scripts/build-android-artifact.mjs');
  const digest = 'a'.repeat(64);
  const signer = `Signer #1 certificate DN: CN=Weave\nSigner #1 certificate SHA-256 digest: ${digest}\n`;
  const manifest = "package: name='com.weave.app' versionCode='7' versionName='2.0.0'\nsdkVersion:'24'\n";
  const expected = { certificateSha256: digest, packageName: 'com.weave.app', versionCode: 7 };
  assert.equal(builder.verifiedReleaseMetadata(signer, manifest, expected).certificateSha256, digest);
  assert.throws(() => builder.verifiedReleaseMetadata(signer.replace('CN=Weave', 'CN=Android Debug'), manifest, expected), /debug/i);
  assert.throws(() => builder.verifiedReleaseMetadata(signer, manifest, { ...expected, certificateSha256: 'b'.repeat(64) }), /certificate/i);
  assert.throws(() => builder.verifiedReleaseMetadata(signer, manifest, { ...expected, versionCode: 8 }), /version/i);
  assert.throws(() => builder.verifiedReleaseMetadata(signer, manifest, { ...expected, packageName: 'com.other.app' }), /package/i);
  assert.throws(() => builder.verifiedReleaseMetadata(signer, manifest + 'application-debuggable\n', expected), /debug/i);
});
