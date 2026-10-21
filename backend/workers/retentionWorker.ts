import { sqlClient } from '../db/index.js';

export class RetentionWorker {
  async runOnce(deliveredDays = 30, generationDays = 30): Promise<{ outbox: number; generations: number }> {
    const outbox = await sqlClient`
      DELETE FROM telemetry.ml_outbox expired
      WHERE expired.status='delivered' AND expired.delivered_at < now()-(${deliveredDays}::text || ' days')::interval
        AND (expired.job_type<>'repo_index' OR EXISTS (
          SELECT 1 FROM telemetry.ml_outbox newer
          WHERE newer.aggregate_id=expired.aggregate_id AND newer.job_type='repo_index'
            AND newer.status='delivered'
            AND (newer.created_at,newer.outbox_id)>(expired.created_at,expired.outbox_id)
        ))
      RETURNING outbox_id
    `;
    const generations = await sqlClient`
      DELETE FROM telemetry.generation_attempts WHERE created_at < now()-(${generationDays}::text || ' days')::interval
      RETURNING generation_id
    `;
    return { outbox: outbox.length, generations: generations.length };
  }
}
