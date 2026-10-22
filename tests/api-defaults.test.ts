import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('frontend development fallback agrees with the backend default listener port',()=>{
  const frontend=fs.readFileSync(new URL('../src/api/config.ts',import.meta.url),'utf8');
  const backend=fs.readFileSync(new URL('../backend/server.ts',import.meta.url),'utf8');
  const frontendPort=frontend.match(/LOCAL_BACKEND_PORT = (\d+)/)?.[1];
  const backendPort=backend.match(/process.env.PORT \?\? '(\d+)'/)?.[1];
  assert.ok(frontendPort&&backendPort);assert.equal(frontendPort,backendPort);
});
