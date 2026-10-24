import 'dotenv/config';
import { sqlClient } from '../db/index.js';
import { createReadmeSummaryGenerator } from '../services/readmeSummaryGenerator.js';
import { ReadmeSummaryService } from '../services/readmeSummaryService.js';
import { runReadmeSummaryWorker } from '../workers/readmeSummaryWorker.js';

const once = process.argv.includes('--once');
const regenerate = process.argv.includes('--regenerate');
const repoIds = process.argv.filter((argument) => argument.startsWith('--repo-id=')).map((argument) => argument.slice(10));
if (repoIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error('Invalid repository UUID');
if (regenerate && !repoIds.length) throw new Error('--regenerate requires explicit --repo-id values');
const limit = Number(process.argv.find((argument) => argument.startsWith('--limit='))?.slice(8) ?? 10);
if (!Number.isInteger(limit) || limit<1 || limit>100) throw new Error('--limit must be 1–100');
const concurrency = Number(process.argv.find(argument => argument.startsWith('--concurrency='))?.slice(14) ?? 2);
if (!Number.isInteger(concurrency) || concurrency<1 || concurrency>2) throw new Error('--concurrency must be 1–2');
const service = new ReadmeSummaryService(createReadmeSummaryGenerator());
const stopping = new AbortController();
let failures = 0;
const stop = () => stopping.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  if (repoIds.length) await service.enqueueMissing(repoIds, regenerate);
  ({ failures } = await runReadmeSummaryWorker(service, { limit, concurrency, once,
    repoIds: repoIds.length ? repoIds : undefined, signal: stopping.signal,
    onResult: result => console.log(JSON.stringify(result)),
  }));
} finally {
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  await sqlClient.end({ timeout: 5 });
}
if (once && failures) process.exitCode=1;
