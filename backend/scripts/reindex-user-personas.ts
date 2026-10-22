import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import postgres from 'postgres';

import { buildMlOnboardingJob, hasMlEmbeddingContext } from '../services/mlOnboardingService.js';

export interface PersonaReindexOptions {
  campaignId: string;
  execute: boolean;
  batchSize: number;
}

interface PersonaRow {
  user_id: string;
  username: string | null;
  full_name: string | null;
  bio: string | null;
  github_handle: string | null;
  avatar_url: string | null;
  interests: unknown;
  skills: unknown;
  tech_stack: unknown;
  profile_version: number;
}

const CAMPAIGN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export function parsePersonaReindexOptions(arguments_: string[]): PersonaReindexOptions {
  let execute = false;
  let campaignId: string | undefined;
  let batchSize = 100;
  for (const argument of arguments_) {
    if (argument === '--execute') execute = true;
    else if (argument.startsWith('--campaign=')) campaignId = argument.slice('--campaign='.length);
    else if (argument.startsWith('--batch-size=')) batchSize = Number(argument.slice('--batch-size='.length));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!campaignId || !CAMPAIGN_PATTERN.test(campaignId)) {
    throw new Error('--campaign must be 3-64 letters, numbers, dots, underscores, or hyphens.');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error('--batch-size must be an integer from 1 to 500.');
  }
  return { campaignId, execute, batchSize };
}

export function personaCampaignIdempotencyKey(
  campaignId: string,
  userId: string,
  profileVersion: number,
): string {
  return `onboard:${userId}:${profileVersion}:campaign:${campaignId}`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export async function runPersonaReindex(
  options: PersonaReindexOptions,
  databaseUrl: string,
): Promise<Record<string, number | string>> {
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  const report = {
    mode: options.execute ? 'execute' : 'dry-run',
    campaign_id: options.campaignId,
    completed_users: 0,
    eligible: 0,
    queued: 0,
    would_queue: 0,
    already_queued: 0,
    invalid: 0,
  };
  try {
    let cursor: string | null = null;
    do {
      const batch = await client.begin(async (tx) => {
        const rows = await tx`
          SELECT user_id,username,full_name,bio,github_handle,avatar_url,
                 interests,skills,tech_stack,profile_version
          FROM app.users
          WHERE status='active' AND onboarding_completed=true
            AND (${cursor}::uuid IS NULL OR user_id>${cursor}::uuid)
          ORDER BY user_id
          LIMIT ${options.batchSize}
          FOR SHARE
        ` as unknown as PersonaRow[];
        let eligible = 0;
        let queued = 0;
        let wouldQueue = 0;
        let alreadyQueued = 0;
        let invalid = 0;
        for (const row of rows) {
          const job = buildMlOnboardingJob(row.user_id, Number(row.profile_version), {
            username: row.username,
            fullName: row.full_name,
            bio: row.bio,
            githubUsername: row.github_handle,
            avatarUrl: row.avatar_url,
            interests: strings(row.interests),
            skills: strings(row.skills),
            techStack: strings(row.tech_stack),
          }, crypto.randomUUID());
          if (!hasMlEmbeddingContext(job.profile)) { invalid++; continue; }
          eligible++;
          const key = personaCampaignIdempotencyKey(
            options.campaignId,
            row.user_id,
            Number(row.profile_version),
          );
          if (options.execute) {
            const inserted = await tx`
              INSERT INTO telemetry.ml_outbox (job_type,aggregate_id,idempotency_key,payload)
              VALUES ('onboard',${row.user_id}::uuid,${key},
                ${tx.json(job as unknown as Parameters<typeof tx.json>[0])})
              ON CONFLICT (idempotency_key) DO NOTHING
              RETURNING outbox_id
            `;
            if (inserted.length === 1) queued++;
            else alreadyQueued++;
          } else {
            const existing = await tx`SELECT 1 FROM telemetry.ml_outbox WHERE idempotency_key=${key}`;
            if (existing.length > 0) alreadyQueued++;
            else wouldQueue++;
          }
        }
        return {
          count: rows.length,
          cursor: rows.at(-1)?.user_id ?? null,
          eligible,
          queued,
          wouldQueue,
          alreadyQueued,
          invalid,
        };
      });
      report.completed_users += batch.count;
      report.eligible += batch.eligible;
      report.queued += batch.queued;
      report.would_queue += batch.wouldQueue;
      report.already_queued += batch.alreadyQueued;
      report.invalid += batch.invalid;
      cursor = batch.cursor;
      if (batch.count < options.batchSize) break;
    } while (cursor);
    return report;
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const report = await runPersonaReindex(
    parsePersonaReindexOptions(process.argv.slice(2)),
    databaseUrl,
  );
  console.log(JSON.stringify(report, null, 2));
  if (Number(report.invalid) > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
