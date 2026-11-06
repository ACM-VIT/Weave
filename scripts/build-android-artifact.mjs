#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preflightOAuthContract } from './oauth-contract-preflight.mjs';

const DEFAULT_BACKEND_URL = 'https://weave-backend.krishang.dev/api';
const DEFAULT_ANDROID_ARCHITECTURES = 'armeabi-v7a,arm64-v8a';
const ARTIFACT_NAME = 'Weave-v2.0.0-release.apk';
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');

const HELP = `Build a signed Weave Android release artifact locally (without EAS).

Usage:
  npm run build:android:artifact
  npm run build:android:artifact -- --prebuild

Options:
  --prebuild  Run "expo prebuild --platform android --no-clean" before Gradle. This is
              opt-in because prebuild modifies the generated native project.
  --help      Show this help without building.

Environment:
  WEAVE_ANDROID_KEYSTORE, WEAVE_ANDROID_KEY_ALIAS,
  WEAVE_ANDROID_STORE_PASSWORD, WEAVE_ANDROID_KEY_PASSWORD,
  WEAVE_ANDROID_CERT_SHA256
              Required persistent release key outside the checkout, its
              credentials and pinned SHA-256 certificate. Debug keys are rejected.
  WEAVE_ANDROID_SIGNING_ENV
              Optional private environment file. Defaults to
              ~/.local/share/weave/signing/release-signing.env when present.
  WEAVE_ARTIFACT_BACKEND_URL
              Optional HTTPS API base URL ending in /api. The build defaults to
              ${DEFAULT_BACKEND_URL} and always overrides EXPO_PUBLIC_BACKEND_URL.
  WEAVE_ARTIFACT_JAVA_HOME
              Optional JDK 17 home. The script otherwise checks JAVA_HOME and
              common Homebrew/macOS JDK 17 locations.
  WEAVE_ARTIFACT_ANDROID_ARCHITECTURES
              Optional comma-separated Android ABIs. Defaults to
              ${DEFAULT_ANDROID_ARCHITECTURES} so QA covers both 32-bit and 64-bit
              physical Android phones. Supported values: armeabi-v7a,
              arm64-v8a, x86, x86_64.

Output:
  artifacts/${ARTIFACT_NAME}
`;

export function parseArguments(arguments_) {
  let shouldPrebuild = false;

  for (const argument of arguments_) {
    if (argument === '--help' || argument === '-h') {
      return { help: true, shouldPrebuild: false };
    }
    if (argument === '--prebuild') {
      shouldPrebuild = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n\n${HELP}`);
  }

  return { help: false, shouldPrebuild };
}

function isPrivateArtifactHostname(rawHostname) {
  const hostname = rawHostname.trim().toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!hostname) return true;
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.home.arpa')
  ) return true;

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const [first, second] = hostname.split('.').map(Number);
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (ipVersion === 6) {
    return hostname === '::'
      || hostname === '::1'
      || /^f[cd]/.test(hostname)
      || /^fe[89ab]/.test(hostname)
      || hostname.startsWith('::ffff:');
  }
  return !hostname.includes('.');
}

export function validatedBackendUrl(value) {
  const candidate = value.trim();
  if (!candidate || /MISSING_CONFIG/i.test(candidate)) {
    throw new Error('Artifact backend URL must be configured and cannot contain MISSING_CONFIG.');
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Artifact backend URL must be a valid absolute URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Artifact backend URL must use HTTPS; cleartext HTTP is rejected.');
  }
  if (!parsed.hostname || parsed.username || parsed.password
    || isPrivateArtifactHostname(parsed.hostname)) {
    throw new Error(
      'Artifact backend URL must have a public hostname and cannot contain credentials.',
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Artifact backend URL cannot contain query parameters or a fragment.');
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  if (!parsed.pathname.endsWith('/api')) {
    throw new Error('Artifact backend URL must end in /api.');
  }

  return parsed.toString().replace(/\/$/, '');
}

export function validatedAndroidArchitectures(value) {
  const supported = new Set(['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64']);
  const architectures = [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
  if (architectures.length === 0 || architectures.some((entry) => !supported.has(entry))) {
    throw new Error(
      'WEAVE_ARTIFACT_ANDROID_ARCHITECTURES must contain only '
      + 'armeabi-v7a, arm64-v8a, x86, or x86_64.',
    );
  }
  return architectures.join(',');
}

export function validatedSigningEnvironment(environment = process.env) {
  for (const name of ['WEAVE_ANDROID_KEYSTORE', 'WEAVE_ANDROID_KEY_ALIAS',
    'WEAVE_ANDROID_STORE_PASSWORD', 'WEAVE_ANDROID_KEY_PASSWORD', 'WEAVE_ANDROID_CERT_SHA256']) {
    if (typeof environment[name] !== 'string' || !environment[name].trim()) {
      throw new Error(`${name} is required for release signing. Run "npm run build:android:artifact -- --help" for setup.`);
    }
  }
  const keyAlias = environment.WEAVE_ANDROID_KEY_ALIAS;
  if (keyAlias.toLowerCase() === 'androiddebugkey') throw new Error('Debug signing keys are not release credentials.');
  const supplied = environment.WEAVE_ANDROID_KEYSTORE;
  if (!path.isAbsolute(supplied) || !existsSync(supplied) || !statSync(supplied).isFile()) throw new Error('Release keystore must be an existing absolute file outside the checkout.');
  const keystorePath = realpathSync(supplied);
  const relative = path.relative(realpathSync(REPOSITORY_ROOT), keystorePath);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
    throw new Error('Release signing keys must remain outside the checkout.');
  }
  const certificateSha256 = environment.WEAVE_ANDROID_CERT_SHA256.replaceAll(':', '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(certificateSha256)) throw new Error('WEAVE_ANDROID_CERT_SHA256 must pin the release certificate SHA-256 digest.');
  return { keystorePath, keyAlias, certificateSha256 };
}

export function verifiedReleaseMetadata(signerOutput, manifestOutput, expected) {
  if (/certificate DN:.*\bCN\s*=\s*Android Debug\b/i.test(signerOutput)) {
    throw new Error('APK uses an Android debug certificate.');
  }
  const certificates = [...signerOutput.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})\s*$/gim)];
  if (certificates.length !== 1 || certificates[0][1].toLowerCase() !== expected.certificateSha256) {
    throw new Error('APK signing certificate does not match the pinned release identity.');
  }
  const manifest = /^package: name='([^']+)' versionCode='(\d+)'/m.exec(manifestOutput);
  if (!manifest || manifest[1] !== expected.packageName) throw new Error('APK package does not match app.json.');
  if (Number(manifest[2]) !== expected.versionCode) throw new Error('APK version code does not match app.json; run prebuild.');
  if (/^application-debuggable\s*$/m.test(manifestOutput)) throw new Error('Release APK is debuggable.');
  return { certificateSha256: certificates[0][1].toLowerCase(), packageName: manifest[1], versionCode: Number(manifest[2]) };
}

function androidBuildTools(environment) {
  let sdk = environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT;
  const properties = path.join(REPOSITORY_ROOT, 'android', 'local.properties');
  if (!sdk && existsSync(properties)) {
    sdk = /^sdk\.dir=(.+)$/m.exec(readFileSync(properties, 'utf8'))?.[1].replace(/\\([ :\\])/g, '$1');
  }
  if (!sdk || !existsSync(path.join(sdk, 'build-tools'))) throw new Error('Android SDK build-tools are required for release verification.');
  const versions = readdirSync(path.join(sdk, 'build-tools')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const root = path.join(sdk, 'build-tools', version);
    const apksigner = path.join(root, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
    const aapt = path.join(root, process.platform === 'win32' ? 'aapt.exe' : 'aapt');
    if (existsSync(apksigner) && existsSync(aapt)) return { apksigner, aapt };
  }
  throw new Error('Android apksigner and aapt are required for release verification.');
}

function captureChecked(command, arguments_, environment) {
  const result = spawnSync(command, arguments_, { env: environment, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Release verification failed: ${path.basename(command)}.`);
  return result.stdout;
}

function runChecked(command, arguments_, label, environment) {
  console.log(`\n${label}`);
  const result = spawnSync(command, arguments_, {
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function javaExecutable(javaHome) {
  return path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

function javaMajorVersion(javaHome) {
  const executable = javaExecutable(javaHome);
  if (!existsSync(executable)) return null;
  const result = spawnSync(executable, ['-version'], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = output.match(/version\s+"(?:1\.)?(\d+)/i);
  return match ? Number(match[1]) : null;
}

function resolveJava17Home() {
  const explicit = process.env.WEAVE_ARTIFACT_JAVA_HOME?.trim();
  if (explicit) {
    if (javaMajorVersion(explicit) !== 17) {
      throw new Error('WEAVE_ARTIFACT_JAVA_HOME must point to a JDK 17 installation.');
    }
    return explicit;
  }

  const candidates = [
    process.env.JAVA_HOME,
    '/opt/homebrew/opt/openjdk@17',
    '/usr/local/opt/openjdk@17',
    '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home',
    '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home',
    '/Library/Java/JavaVirtualMachines/openjdk-17.jdk/Contents/Home',
  ].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    if (javaMajorVersion(candidate) === 17) return candidate;
  }

  throw new Error(
    'JDK 17 is required for Android builds. Install openjdk@17 or set WEAVE_ARTIFACT_JAVA_HOME.',
  );
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const input = createReadStream(filePath);
    input.on('data', (chunk) => digest.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(digest.digest('hex')));
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  const signingFile = process.env.WEAVE_ANDROID_SIGNING_ENV
    ?? path.join(homedir(), '.local', 'share', 'weave', 'signing', 'release-signing.env');
  if (existsSync(signingFile)) process.loadEnvFile(signingFile);
  else if (process.env.WEAVE_ANDROID_SIGNING_ENV) throw new Error('The configured release-signing environment file is missing.');
  const signing = validatedSigningEnvironment();

  const backendUrl = validatedBackendUrl(
    process.env.WEAVE_ARTIFACT_BACKEND_URL ?? DEFAULT_BACKEND_URL,
  );
  const androidArchitectures = validatedAndroidArchitectures(
    process.env.WEAVE_ARTIFACT_ANDROID_ARCHITECTURES ?? DEFAULT_ANDROID_ARCHITECTURES,
  );
  console.log(`Preflighting GitHub and Google OAuth against ${backendUrl}`);
  await preflightOAuthContract(backendUrl);
  console.log('Verified OAuth broker contract for GitHub and Google');

  const javaHome = resolveJava17Home();
  const buildEnvironment = {
    ...process.env,
    WEAVE_ANDROID_KEYSTORE: signing.keystorePath,
    WEAVE_ANDROID_CERT_SHA256: signing.certificateSha256,
    EXPO_PUBLIC_BACKEND_URL: backendUrl,
    JAVA_HOME: javaHome,
    NODE_ENV: 'production',
    PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    // Upload source maps separately using scoped Sentry credentials.
    SENTRY_DISABLE_AUTO_UPLOAD: 'true',
  };

  console.log(`Building signed release APK against ${backendUrl}`);
  console.log(`Using JDK 17 from ${javaHome}`);
  console.log(`Building Android ABI(s): ${androidArchitectures}`);

  if (options.shouldPrebuild) {
    const expoExecutable = path.join(
      REPOSITORY_ROOT,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'expo.cmd' : 'expo',
    );
    if (!existsSync(expoExecutable)) {
      throw new Error('Expo CLI is not installed locally. Run npm ci first.');
    }
    runChecked(
      expoExecutable,
      ['prebuild', '--platform', 'android', '--no-clean'],
      'Running Expo prebuild (preserving the existing native project)',
      buildEnvironment,
    );
  }

  const gradleWrapper = path.join(
    REPOSITORY_ROOT,
    'android',
    process.platform === 'win32' ? 'gradlew.bat' : 'gradlew',
  );
  if (!existsSync(gradleWrapper)) {
    throw new Error(
      'android/gradlew is missing. Re-run with --prebuild to generate the Android project.',
    );
  }

  const releaseBundle = path.join(
    REPOSITORY_ROOT,
    'android',
    'app',
    'build',
    'generated',
    'assets',
    'react',
    'release',
    'index.android.bundle',
  );
  // Expo's bundle task does not declare EXPO_PUBLIC_* values as Gradle inputs.
  // Removing this one generated output invalidates the bundle task while
  // preserving Gradle's native compilation cache for fast frontend rebuilds.
  rmSync(releaseBundle, { force: true });

  runChecked(
    gradleWrapper,
    [
      'app:assembleRelease',
      '-p',
      'android',
      `-PreactNativeArchitectures=${androidArchitectures}`,
      '--max-workers=2',
    ],
    'Assembling Android release APK',
    buildEnvironment,
  );

  if (!existsSync(releaseBundle)) {
    throw new Error(`Gradle succeeded but the release bundle was not found at ${releaseBundle}.`);
  }
  const bundleBytes = readFileSync(releaseBundle);
  if (!bundleBytes.includes(Buffer.from(backendUrl, 'utf8'))) {
    throw new Error(`Release bundle verification failed: ${backendUrl} is not embedded.`);
  }
  for (const forbiddenValue of [
    'http://MISSING_CONFIG',
    'http://localhost:3000',
    'https://localhost:3000',
    'http://127.0.0.1:3000',
  ]) {
    if (bundleBytes.includes(Buffer.from(forbiddenValue, 'utf8'))) {
      throw new Error(`Release bundle verification failed: ${forbiddenValue} is embedded.`);
    }
  }

  const gradleOutput = path.join(
    REPOSITORY_ROOT,
    'android',
    'app',
    'build',
    'outputs',
    'apk',
    'release',
    'app-release.apk',
  );
  if (!existsSync(gradleOutput)) {
    throw new Error(`Gradle succeeded but the APK was not found at ${gradleOutput}.`);
  }
  const tools = androidBuildTools(buildEnvironment);
  const config = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, 'app.json'), 'utf8')).expo;
  const metadata = verifiedReleaseMetadata(
    captureChecked(tools.apksigner, ['verify', '--print-certs', gradleOutput], buildEnvironment),
    captureChecked(tools.aapt, ['dump', 'badging', gradleOutput], buildEnvironment),
    { certificateSha256: signing.certificateSha256, packageName: config.android.package, versionCode: config.android.versionCode },
  );

  const artifactDirectory = path.join(REPOSITORY_ROOT, 'artifacts');
  const artifactPath = path.join(artifactDirectory, ARTIFACT_NAME);
  const temporaryArtifactPath = `${artifactPath}.${process.pid}.tmp`;
  mkdirSync(artifactDirectory, { recursive: true });
  rmSync(temporaryArtifactPath, { force: true });
  try {
    copyFileSync(gradleOutput, temporaryArtifactPath);
    renameSync(temporaryArtifactPath, artifactPath);
  } finally {
    rmSync(temporaryArtifactPath, { force: true });
  }

  const digest = await sha256File(artifactPath);
  console.log(`\nArtifact: ${path.relative(REPOSITORY_ROOT, artifactPath)}`);
  console.log(`Verified backend: ${backendUrl}`);
  console.log(`Verified package: ${metadata.packageName} (${metadata.versionCode})`);
  console.log(`Signing certificate SHA-256: ${metadata.certificateSha256}`);
  console.log(`SHA-256: ${digest}`);
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch((error) => {
    console.error(`\nBuild failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
