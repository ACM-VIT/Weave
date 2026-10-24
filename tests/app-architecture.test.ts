import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("api defaults", () => {
  test('frontend development fallback agrees with the backend default listener port',()=>{
    const frontend=fs.readFileSync(new URL('../src/api/config.ts',import.meta.url),'utf8');
    const backend=fs.readFileSync(new URL('../backend/server.ts',import.meta.url),'utf8');
    const frontendPort=frontend.match(/LOCAL_BACKEND_PORT = (\d+)/)?.[1];
    const backendPort=backend.match(/process.env.PORT \?\? '(\d+)'/)?.[1];
    assert.ok(frontendPort&&backendPort);assert.equal(frontendPort,backendPort);
  });
});

describe("runtime data", () => {
  const root = join(import.meta.dirname, '../src');

  function runtimeFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? runtimeFiles(join(directory, entry.name))
      : /\.[jt]sx?$/.test(entry.name) ? [join(directory, entry.name)] : []);
  }

  test('runtime code cannot enable the removed demo authentication or repository substitution', () => {
    for (const file of runtimeFiles(root)) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /DEVELOPMENT_PREVIEW_|DEVELOPMENT_REPOSITORIES|EXPO_PUBLIC_BYPASS_AUTH|\blocalOnly\b/, file);
    }
    assert.equal(existsSync(join(root, 'data/development-repositories.ts')), false);
    assert.equal(existsSync(join(root, 'config/development-preview.ts')), false);
  });
});
