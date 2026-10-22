import { sqlClient } from '../db/index.js';
import { resolveOutboxLeaseMs } from './outboxService.js';
import { notifyOutboxAfterCommit } from './outboxWakeup.js';

export class DataReconciliationService {
  async reconcileCounters(): Promise<void> {
    await sqlClient.begin(async (tx) => {
      await tx`
        UPDATE app.repo_engagement engagement SET
          likes_count=(SELECT count(*) FROM app.reactions r WHERE r.repo_id=engagement.repo_id AND r.reaction='like'),
          dislikes_count=(SELECT count(*) FROM app.reactions r WHERE r.repo_id=engagement.repo_id AND r.reaction='dislike'),
          saves_count=(SELECT count(*) FROM app.saves s WHERE s.repo_id=engagement.repo_id),
          comments_count=(SELECT count(*) FROM app.comments c WHERE c.repo_id=engagement.repo_id),
          views_count=(SELECT COALESCE(sum(e.impressions),0) FROM telemetry.user_repo_engagement e
            WHERE e.repo_id=engagement.repo_id),updated_at=now()
      `;
      await tx`
        UPDATE app.user_stats stats SET
          likes_given_count=(SELECT count(*) FROM app.reactions r WHERE r.user_id=stats.user_id AND r.reaction='like'),
          saved_repos_count=(SELECT count(*) FROM app.saves s WHERE s.user_id=stats.user_id),updated_at=now()
      `;
    });
  }

  async resetAbandonedClaims(leaseMs = resolveOutboxLeaseMs()): Promise<number> {
    return sqlClient.begin(async (tx) => {
      const rows = await tx`
        UPDATE telemetry.ml_outbox SET status='pending',claim_token=NULL,claimed_at=NULL,available_at=now()
        WHERE status='claimed' AND claimed_at < now()-(${leaseMs}::text || ' milliseconds')::interval RETURNING outbox_id
      `;
      if (rows.length) await notifyOutboxAfterCommit(tx);
      return rows.length;
    });
  }
}
