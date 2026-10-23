import { readFile, stat, writeFile } from 'node:fs/promises';
import { compareColdStartRuns } from '../services/coldStartComparison.js';
import type { ColdStartContextInput } from '../services/coldStartContextExport.js';
const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== '--input' || args[2] !== '--runs' || args[4] !== '--output') {
  throw new Error('Usage: compare-cold-start-profiles --input private-input.json --runs private-measured-runs.json --output private-comparison.json');
}
async function boundedJson(filename: string) {
  if ((await stat(filename)).size > 8388608)
    throw new Error('Comparison input exceeds8MiB.');
  const raw = await readFile(filename, 'utf8');
  if (Buffer.byteLength(raw) > 8388608)
    throw new Error('Comparison input exceeds8MiB.');
  return JSON.parse(raw);
}
const input = await boundedJson(args[1]) as ColdStartContextInput;
const report = compareColdStartRuns(input, await boundedJson(args[3]));
await writeFile(args[5], JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Compared onboarding_only,github_only,combined actual supplied stage exports; production_qualified=false.');
