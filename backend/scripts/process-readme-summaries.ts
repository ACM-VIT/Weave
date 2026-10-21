import 'dotenv/config';
import { sqlClient } from '../db/index.js';
import { createReadmeSummaryGenerator } from '../services/readmeSummaryGenerator.js';
import { ReadmeSummaryService } from '../services/readmeSummaryService.js';

const once = process.argv.includes('--once');
const regenerate = process.argv.includes('--regenerate');
const repoIds = process.argv.filter((argument) => argument.startsWith('--repo-id=')).map((argument) => argument.slice(10));
if (repoIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error('Invalid repository UUID');
if (regenerate && !repoIds.length) throw new Error('--regenerate requires explicit --repo-id values');
const limit = Number(process.argv.find((argument) => argument.startsWith('--limit='))?.slice(8) ?? 10);
if (!Number.isInteger(limit) || limit<1 || limit>100) throw new Error('--limit must be 1–100');
const service = new ReadmeSummaryService(createReadmeSummaryGenerator());
let stopping = false;
let failures = 0;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
try {
  if (repoIds.length) await service.enqueueMissing(repoIds, regenerate);
  do {
    for (let count=0; count<limit && !stopping; count++) {
      const result = await service.processOne(repoIds.length ? repoIds : undefined);
      if (result.status==='idle') break;
      console.log(JSON.stringify(result));
      if (result.status==='failed' || result.status==='retry_scheduled') failures++;
      if (['summary_provider_daily_quota_exhausted','summary_provider_policy_blocked','summary_provider_http_401','summary_provider_http_403'].includes(result.error ?? '')) {
        stopping = true;
        break;
      }
    }
    if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, 3000));
  } while (!once && !stopping);
} finally { await sqlClient.end({ timeout: 5 }); }
if (once && failures) process.exitCode=1;
