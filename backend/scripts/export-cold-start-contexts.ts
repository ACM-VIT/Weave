import { readFile, writeFile, stat } from 'node:fs/promises';
import { exportColdStartContexts, type ColdStartContextInput } from '../services/coldStartContextExport.js';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') {
  throw new Error('Usage: export-cold-start-contexts --input private-input.json --output private-contexts.json');
}
if ((await stat(args[1])).size > 8_388_608) throw new Error('Context input exceeds 8 MiB.');
const raw = await readFile(args[1], 'utf8');
if (Buffer.byteLength(raw, 'utf8') > 8_388_608) throw new Error('Context input exceeds 8 MiB.');
const result = exportColdStartContexts(JSON.parse(raw) as ColdStartContextInput);
await writeFile(args[3], JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Exported three context variants. evaluation_ready=false; no model, database or network operation was performed.');
