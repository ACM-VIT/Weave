import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

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
