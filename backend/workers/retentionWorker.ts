import { sqlClient } from '../db/index.js';

export class RetentionWorker {
  async runOnce(deliveredDays = 30, generationDays = 30): Promise<{ outbox: number; generations: number }> {
    const outbox = await sqlClient`
      WITH versioned_indexes AS (
        SELECT outbox_id,aggregate_id,created_at,
          CASE WHEN payload->>'content_version' ~ '^[1-9][0-9]{0,9}$'
            THEN CASE WHEN (payload->>'content_version')::numeric <= 2147483647
              THEN (payload->>'content_version')::numeric END
          END AS content_version
        FROM telemetry.ml_outbox
        WHERE job_type='repo_index' AND status='delivered'
      ), numeric_checkpoints AS (
        SELECT DISTINCT ON (aggregate_id) outbox_id
        FROM versioned_indexes WHERE content_version IS NOT NULL
        ORDER BY aggregate_id,content_version DESC,created_at DESC,outbox_id DESC
      )
      DELETE FROM telemetry.ml_outbox expired
      WHERE expired.status='delivered' AND expired.delivered_at < now()-(${deliveredDays}::text || ' days')::interval
        -- Keep both the legacy/latest-time witness and the highest valid int32
        -- content version. A same-transaction UUID or malformed newer payload
        -- must not erase the index prerequisite for a numeric successor.
        AND NOT EXISTS (SELECT 1 FROM numeric_checkpoints checkpoint WHERE checkpoint.outbox_id=expired.outbox_id)
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
