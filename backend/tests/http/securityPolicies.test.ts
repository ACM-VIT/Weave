import assert from 'node:assert/strict';
import test from 'node:test';

import { isCorsOriginAllowed, resolveClientRedirect } from '../../security/originPolicy.js';

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
});
