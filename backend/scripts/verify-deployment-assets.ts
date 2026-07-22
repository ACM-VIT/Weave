import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface MigrationJournal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

interface SchemaManifest {
  schemas: string[];
  tables: Record<string, string[]>;
  indexes: string[];
  functions: string[];
  roles: string[];
}

function requireFile(filePath: string): void {
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Required deployment asset is missing: ${filePath}`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseDirectoryCandidates = [
  path.resolve(here, '../../database'),
  path.resolve(here, '../../../database'),
];
const databaseDirectory = databaseDirectoryCandidates.find((candidate) =>
  fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
);

if (!databaseDirectory) {
  throw new Error(
    `Database deployment assets are missing; checked ${databaseDirectoryCandidates.join(', ')}.`,
  );
}

const migrationsDirectory = path.join(databaseDirectory, 'migrations');
const journalPath = path.join(migrationsDirectory, 'meta/_journal.json');
const manifestPath = path.join(databaseDirectory, 'audits/expected-v2-schema.json');
requireFile(journalPath);
requireFile(manifestPath);

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as MigrationJournal;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SchemaManifest;

if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
  throw new Error('Migration journal must contain at least one entry.');
}

const tags = new Set<string>();
let previousTimestamp = -Infinity;
for (const [position, entry] of journal.entries.entries()) {
  if (
    !Number.isInteger(entry.idx)
    || !/^\d{4}_[a-z0-9_]+$/.test(entry.tag)
    || !Number.isInteger(entry.when)
    || entry.when <= 0
  ) {
    throw new Error(`Invalid migration journal entry: ${JSON.stringify(entry)}`);
  }
  if (entry.idx !== position) {
    throw new Error(`Migration journal index ${entry.idx} is out of sequence at position ${position}.`);
  }
  if (entry.when <= previousTimestamp) {
    throw new Error(`Migration journal timestamp is out of sequence: ${entry.tag}`);
  }
  if (tags.has(entry.tag)) throw new Error(`Duplicate migration tag: ${entry.tag}`);
  tags.add(entry.tag);
  previousTimestamp = entry.when;

  const sqlPath = path.join(migrationsDirectory, `${entry.tag}.sql`);
  requireFile(sqlPath);
  if (!fs.readFileSync(sqlPath, 'utf8').trim()) {
    throw new Error(`Migration SQL is empty: ${sqlPath}`);
  }
}

const unjournaledSqlFiles = fs.readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith('.sql'))
  .filter((name) => !tags.has(path.basename(name, '.sql')));
if (unjournaledSqlFiles.length > 0) {
  throw new Error(
    `Migration SQL is not recorded in meta/_journal.json: ${unjournaledSqlFiles.join(', ')}`,
  );
}

for (const name of ['schemas', 'indexes', 'functions', 'roles'] as const) {
  const value = manifest[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw new Error(`Schema manifest field is invalid: ${name}`);
  }
}
if (!manifest.tables || typeof manifest.tables !== 'object' || Array.isArray(manifest.tables)) {
  throw new Error('Schema manifest field is invalid: tables');
}
for (const [schema, tables] of Object.entries(manifest.tables)) {
  if (!schema || !Array.isArray(tables)
    || tables.some((table) => typeof table !== 'string' || !table)) {
    throw new Error(`Schema manifest table list is invalid: ${schema || '<empty>'}`);
  }
}

for (const command of [
  'deployment-environment-preflight.js',
  'migrate.js',
  'schema-audit.js',
]) {
  requireFile(path.join(here, command));
}

console.log(
  `Deployment assets verified: ${journal.entries.length} migrations and schema manifest present.`,
);
