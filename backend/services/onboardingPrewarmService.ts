import crypto from 'node:crypto';

import { sqlClient } from '../db/index.js';
import { retryDelayMs } from './outboxService.js';

export interface OnboardingPrewarmClaim {
  outboxId: string;
  userId: string;
  profileVersion: string;
  feedVersion: bigint;
  token: string;
  attempts: number;
}

const PREWARM_LEASE_MS = 300_000;
const PREWARM_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** A bounded durable side lane stored separately from the delivery acknowledgement. */
export class OnboardingPrewarmService {
  async claim(): Promise<OnboardingPrewarmClaim | 'superseded' | null> {
    return sqlClient.begin(async (tx) => {
      const candidates = await tx`
        SELECT outbox_id,aggregate_id,response_payload->'backend_onboarding_prewarm' AS prewarm
        FROM telemetry.ml_outbox
        WHERE job_type='onboard' AND status='delivered'
          AND response_payload #>> '{backend_onboarding_prewarm,status}' IN ('pending','claimed')
          AND available_at<=now()
        ORDER BY available_at,outbox_id
        FOR UPDATE SKIP LOCKED LIMIT 1
      `;
      const candidate = candidates[0];
      if (!candidate) return null;
      const prewarm = candidate.prewarm as Record<string, unknown>;
      const current = await tx`
        SELECT users.profile_version::text,feed.feed_version::text
        FROM app.users users JOIN app.user_feed_state feed USING(user_id)
        WHERE users.user_id=${String(candidate.aggregate_id)}::uuid AND users.status='active'
      `;
      const superseded = !current[0]
        || current[0].profile_version !== String(prewarm.profile_version)
        || current[0].feed_version !== prewarm.feed_version;
      const expired = Number(prewarm.attempts) >= 10
        || Date.now() - Date.parse(String(prewarm.created_at)) > PREWARM_MAX_AGE_MS;
      if (superseded || expired) {
        await tx`
          UPDATE telemetry.ml_outbox
          SET response_payload=jsonb_set(response_payload,'{backend_onboarding_prewarm}',
            (response_payload->'backend_onboarding_prewarm') ||
              jsonb_build_object('status',${superseded ? 'superseded' : 'abandoned'}::text,
                'claim_token',NULL,'claimed_at',NULL,'finished_at',now()))
          WHERE outbox_id=${String(candidate.outbox_id)}::uuid
        `;
        return 'superseded';
      }
      const token = crypto.randomUUID();
      const attempts = Number(prewarm.attempts) + 1;
      await tx`
        UPDATE telemetry.ml_outbox
        SET available_at=now()+(${PREWARM_LEASE_MS}::text || ' milliseconds')::interval,
          response_payload=jsonb_set(response_payload,'{backend_onboarding_prewarm}',
          (response_payload->'backend_onboarding_prewarm') || jsonb_build_object(
            'status','claimed','claim_token',${token}::text,'claimed_at',now(),'attempts',${attempts}::int))
        WHERE outbox_id=${String(candidate.outbox_id)}::uuid
      `;
      return {
        outboxId: String(candidate.outbox_id), userId: String(candidate.aggregate_id),
        profileVersion: String(prewarm.profile_version), feedVersion: BigInt(String(prewarm.feed_version)),
        token, attempts,
      };
    });
  }

  async isCurrent(claim: OnboardingPrewarmClaim): Promise<boolean> {
    const rows = await sqlClient`
      SELECT 1 FROM telemetry.ml_outbox outbox
      JOIN app.users users ON users.user_id=outbox.aggregate_id
      JOIN app.user_feed_state feed ON feed.user_id=users.user_id
      WHERE outbox.outbox_id=${claim.outboxId}::uuid AND outbox.status='delivered'
        AND outbox.response_payload #>> '{backend_onboarding_prewarm,status}'='claimed'
        AND outbox.response_payload #>> '{backend_onboarding_prewarm,claim_token}'=${claim.token}
        AND users.status='active' AND users.profile_version=${claim.profileVersion}::bigint
        AND feed.feed_version=${claim.feedVersion.toString()}::bigint
        AND outbox.available_at>now()
    `;
    return rows.length === 1;
  }

  async finish(claim: OnboardingPrewarmClaim, completed: boolean, error?: string): Promise<void> {
    const delay = Math.max(1_000, retryDelayMs(claim.attempts));
    await sqlClient`
      UPDATE telemetry.ml_outbox outbox
      SET available_at=now()+(${delay}::text || ' milliseconds')::interval,
        response_payload=jsonb_set(response_payload,'{backend_onboarding_prewarm}',
        (response_payload->'backend_onboarding_prewarm') || jsonb_build_object(
          'status',CASE WHEN NOT EXISTS (
            SELECT 1 FROM app.users users JOIN app.user_feed_state feed USING(user_id)
            WHERE users.user_id=outbox.aggregate_id AND users.status='active'
              AND users.profile_version=${claim.profileVersion}::bigint
              AND feed.feed_version=${claim.feedVersion.toString()}::bigint
          ) THEN 'superseded' WHEN ${completed} THEN 'completed'
            WHEN ${claim.attempts}>=10 THEN 'abandoned' ELSE 'pending' END,
          'claim_token',NULL,'claimed_at',NULL,'last_error',${error?.slice(0, 120) ?? null}::text,
          'available_at',now()+(${delay}::text || ' milliseconds')::interval
        ))
      WHERE outbox_id=${claim.outboxId}::uuid AND status='delivered'
        AND response_payload #>> '{backend_onboarding_prewarm,status}'='claimed'
        AND response_payload #>> '{backend_onboarding_prewarm,claim_token}'=${claim.token}
    `;
  }
}
