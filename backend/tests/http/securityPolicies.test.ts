import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isCorsOriginAllowed,
  resolveBackendCallbackUrl,
  resolveClientRedirect,
} from '../../security/originPolicy.js';

test('production CORS permits only configured browser origins and native requests', () => {
  const configured = ['https://weave.expo.app'];
  assert.equal(isCorsOriginAllowed(undefined, configured, 'production'), true);
  assert.equal(isCorsOriginAllowed('https://weave.expo.app/', configured, 'production'), true);
  assert.equal(isCorsOriginAllowed('https://attacker.example', configured, 'production'), false);
  assert.equal(isCorsOriginAllowed('http://localhost:8081', configured, 'production'), false);
});

test('development CORS accepts private development hosts', () => {
  assert.equal(isCorsOriginAllowed('http://localhost:8081', [], 'development'), true);
  assert.equal(isCorsOriginAllowed('http://192.168.1.20:8081', [], 'development'), true);
  assert.equal(isCorsOriginAllowed('http://[::1]:8081', [], 'development'), true);
  assert.equal(isCorsOriginAllowed('https://public.example', [], 'development'), false);
});

test('OAuth redirects accept configured origins and reject open redirects', () => {
  const fallback = 'ghsocial://callback';
  const allowed = ['https://weave.expo.app', 'ghsocial://callback'];
  assert.equal(
    resolveClientRedirect('https://weave.expo.app/callback?source=github', fallback, allowed, 'production'),
    'https://weave.expo.app/callback?source=github',
  );
  assert.equal(
    resolveClientRedirect('https://attacker.example/callback', fallback, allowed, 'production'),
    fallback,
  );
  assert.equal(
    resolveClientRedirect('https://weave.expo.app@attacker.example/callback', fallback, allowed, 'production'),
    fallback,
  );
  assert.equal(
    resolveClientRedirect('ghsocial://callback?source=github', fallback, allowed, 'production'),
    'ghsocial://callback?source=github',
  );
  assert.equal(
    resolveClientRedirect('attacker://callback', fallback, allowed, 'production'),
    fallback,
  );
});

test('development OAuth callback follows the configured API port on private hosts', () => {
  assert.equal(
    resolveBackendCallbackUrl(
      '10.0.2.2:5001',
      'https://weave-backend.example',
      '5001',
      'development',
    ).toString(),
    'http://10.0.2.2:5001/api/auth/callback',
  );
  assert.equal(
    resolveBackendCallbackUrl(
      '192.168.1.20:5001',
      'https://weave-backend.example',
      '5001',
      'development',
    ).toString(),
    'http://192.168.1.20:5001/api/auth/callback',
  );
  assert.equal(
    resolveBackendCallbackUrl(
      '[::1]:5001',
      'https://weave-backend.example',
      '5001',
      'development',
    ).toString(),
    'http://[::1]:5001/api/auth/callback',
  );
});

test('OAuth callback rejects public or wrong-port Host headers and is fixed in production', () => {
  for (const host of ['attacker.example:5001', '10.0.2.2:5000']) {
    assert.equal(
      resolveBackendCallbackUrl(
        host,
        'https://weave-backend.example',
        '5001',
        'development',
      ).toString(),
      'https://weave-backend.example/api/auth/callback',
    );
  }
  assert.equal(
    resolveBackendCallbackUrl(
      '10.0.2.2:5001',
      'https://weave-backend.example',
      '5001',
      'production',
    ).toString(),
    'https://weave-backend.example/api/auth/callback',
  );
});
