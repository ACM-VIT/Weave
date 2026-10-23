/** Deterministic, offline generation from the vendored ML release contract. */
import { readFile, writeFile } from 'node:fs/promises';
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript';

const schema = new URL('../contracts/ml-v2.openapi.json', import.meta.url);
const output = new URL('../contracts/ml-v2.generated.ts', import.meta.url);
const rendered = COMMENT_HEADER + astToString(await openapiTS(schema, { defaultNonNullable: false }));
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== rendered) {
    throw new Error('ML client is stale. Run npm run ml:generate after updating the provider contract.');
  }
} else {
  await writeFile(output, rendered);
}
