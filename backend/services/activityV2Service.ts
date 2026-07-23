import {
  FEED_INVALIDATING_EVENTS,
  ML_RELEVANT_EVENTS,
  type InteractionBatchResultV2,
  type InteractionEventType,
  type InteractionEventV2,
} from '../contracts/interactions.v2.js';
import { FEEDBACK_WEIGHTS } from '../config/feedback.js';
import { sqlClient } from '../db/index.js';
import type postgres from 'postgres';
import { buildMlFeedbackEvent } from './mlFeedbackPayloadService.js';
import { setRepositorySaved } from './savedRepositoryService.js';

export type ReactionState = 'like' | 'dislike' | null;

export function transitionReaction(current: ReactionState, event: InteractionEventType): ReactionState {
  if (event === 'like') return 'like';
  if (event === 'dislike') return 'dislike';
  if (event === 'unlike' && current === 'like') return null;
  if (event === 'undislike' && current === 'dislike') return null;
  return current;
}

function scoreFor(event: InteractionEventV2): number {
  if (event.event_type === 'dwell') {
    const dwell = Math.min(300_000, Math.max(3_000, event.dwell_ms ?? 3_000));
    return 0.15 * (Math.log1p(dwell) / Math.log1p(300_000));
  }
  return FEEDBACK_WEIGHTS[event.event_type as keyof typeof FEEDBACK_WEIGHTS] ?? 0;
}

export async function processInteractionBatchV2InTransaction(
  tx: postgres.TransactionSql,
  userId: string,
  events: InteractionEventV2[],
): Promise<InteractionBatchResultV2> {
    await tx`
      INSERT INTO app.user_feed_state (user_id) VALUES (${userId}::uuid)
      ON CONFLICT (user_id) DO NOTHING
    `;
    const states = await tx`
      SELECT feed_version, feedback_version FROM app.user_feed_state
      WHERE user_id=${userId}::uuid FOR UPDATE
    `;
    if (states.length === 0) throw new Error('User feed state is unavailable.');
    let feedVersion = BigInt(states[0].feed_version);
    let feedbackVersion = BigInt(states[0].feedback_version);
    let invalidateFeed = false;
    const results = new Map<string, { event_id: string; status: 'accepted' | 'duplicate'; feedback_version?: string }>();

    // Repository engagement rows are shared across users. Lock them in a
    // deterministic order to prevent cross-user deadlocks, then apply the
    // events in the exact order supplied by the client. Event IDs provide
    // idempotency only and must never determine state-transition order.
    const repoIds = [...new Set(events.map((event) => event.repo_id))].sort();
    for (const repoId of repoIds) {
      await tx`INSERT INTO app.repo_engagement (repo_id) VALUES (${repoId}::uuid) ON CONFLICT DO NOTHING`;
      await tx`SELECT repo_id FROM app.repo_engagement WHERE repo_id=${repoId}::uuid FOR UPDATE`;
    }

    for (const event of events) {
      if (event.serve_id) {
        const served = await tx`
          SELECT 1 FROM telemetry.feed_serves serve
          JOIN telemetry.feed_serve_items item ON item.serve_id=serve.serve_id
          WHERE serve.serve_id=${event.serve_id}::uuid AND serve.user_id=${userId}::uuid
            AND item.repo_id=${event.repo_id}::uuid AND item.position=${event.position}
        `;
        if (served.length === 0) throw new Error(`Event ${event.event_id} does not match its serve item.`);
      }

      const inserted = await tx`
        INSERT INTO telemetry.interaction_events (
          event_id,schema_version,user_id,session_id,serve_id,repo_id,position,event_type,dwell_ms,
          client_occurred_at,context
        ) VALUES (
          ${event.event_id}::uuid,2,${userId}::uuid,${event.session_id}::uuid,${event.serve_id}::uuid,
          ${event.repo_id}::uuid,${event.position},${event.event_type},${event.dwell_ms},
          ${event.client_occurred_at}::timestamptz,${JSON.stringify(event.context)}::jsonb
        ) ON CONFLICT (event_id) DO NOTHING RETURNING event_id
      `;
      if (inserted.length === 0) {
        const existing = await tx`
          SELECT user_id,session_id,serve_id,repo_id,position,event_type,dwell_ms,client_occurred_at
          FROM telemetry.interaction_events WHERE event_id=${event.event_id}::uuid
        `;
        const row = existing[0];
        const same = row
          && String(row.user_id) === userId
          && String(row.session_id) === event.session_id
          && (row.serve_id == null ? null : String(row.serve_id)) === event.serve_id
          && String(row.repo_id) === event.repo_id
          && (row.position == null ? null : Number(row.position)) === event.position
          && row.event_type === event.event_type
          && (row.dwell_ms == null ? null : Number(row.dwell_ms)) === event.dwell_ms
          && new Date(row.client_occurred_at as string).toISOString() === new Date(event.client_occurred_at).toISOString();
        if (!same) throw new Error(`Event ${event.event_id} was reused with different content.`);
        results.set(event.event_id, { event_id: event.event_id, status: 'duplicate' });
        continue;
      }

      let stateChanged = false;
      if (['like', 'unlike', 'dislike', 'undislike'].includes(event.event_type)) {
        const currentRows = await tx`
          SELECT reaction FROM app.reactions
          WHERE user_id=${userId}::uuid AND repo_id=${event.repo_id}::uuid FOR UPDATE
        `;
        const before = (currentRows[0]?.reaction as ReactionState | undefined) ?? null;
        const after = transitionReaction(before, event.event_type);
        stateChanged = before !== after;
        if (stateChanged) {
          if (after === null) {
            await tx`DELETE FROM app.reactions WHERE user_id=${userId}::uuid AND repo_id=${event.repo_id}::uuid`;
          } else {
            await tx`
              INSERT INTO app.reactions (user_id,repo_id,reaction) VALUES (${userId}::uuid,${event.repo_id}::uuid,${after})
              ON CONFLICT (user_id,repo_id) DO UPDATE SET reaction=EXCLUDED.reaction,updated_at=now()
            `;
          }
          const likeDelta = Number(after === 'like') - Number(before === 'like');
          const dislikeDelta = Number(after === 'dislike') - Number(before === 'dislike');
          await tx`INSERT INTO app.repo_engagement (repo_id) VALUES (${event.repo_id}::uuid) ON CONFLICT DO NOTHING`;
          await tx`
            UPDATE app.repo_engagement SET
              likes_count=GREATEST(0,likes_count+${likeDelta}),
              dislikes_count=GREATEST(0,dislikes_count+${dislikeDelta}),updated_at=now()
            WHERE repo_id=${event.repo_id}::uuid
          `;
          await tx`
            UPDATE app.user_stats SET likes_given_count=GREATEST(0,likes_given_count+${likeDelta}),updated_at=now()
            WHERE user_id=${userId}::uuid
          `;
        }
      } else if (event.event_type === 'save' || event.event_type === 'unsave') {
        stateChanged = await setRepositorySaved(
          tx,
          userId,
          event.repo_id,
          event.event_type === 'save',
        );
      } else if (event.event_type === 'impression') {
        // The event insert above is the idempotency boundary, so retries never
        // double-count the repository's public view total.
        await tx`
          UPDATE app.repo_engagement SET views_count=views_count+1,updated_at=now()
          WHERE repo_id=${event.repo_id}::uuid
        `;
      }

      await tx`
        INSERT INTO telemetry.user_repo_engagement (
          user_id,repo_id,impressions,readme_opens,github_opens,shares,total_dwell_ms,feedback_score,last_event_at
        ) VALUES (
          ${userId}::uuid,${event.repo_id}::uuid,
          ${event.event_type === 'impression' ? 1 : 0},${event.event_type === 'readme_open' ? 1 : 0},
          ${event.event_type === 'github_open' ? 1 : 0},${event.event_type === 'share' ? 1 : 0},
          ${event.dwell_ms ?? 0},${scoreFor(event)},${event.client_occurred_at}::timestamptz
        ) ON CONFLICT (user_id,repo_id) DO UPDATE SET
          impressions=telemetry.user_repo_engagement.impressions+EXCLUDED.impressions,
          readme_opens=telemetry.user_repo_engagement.readme_opens+EXCLUDED.readme_opens,
          github_opens=telemetry.user_repo_engagement.github_opens+EXCLUDED.github_opens,
          shares=telemetry.user_repo_engagement.shares+EXCLUDED.shares,
          total_dwell_ms=telemetry.user_repo_engagement.total_dwell_ms+EXCLUDED.total_dwell_ms,
          feedback_score=telemetry.user_repo_engagement.feedback_score+EXCLUDED.feedback_score,
          last_event_at=GREATEST(telemetry.user_repo_engagement.last_event_at,EXCLUDED.last_event_at)
      `;

      let assigned: string | undefined;
      if (ML_RELEVANT_EVENTS.has(event.event_type)) {
        feedbackVersion += 1n;
        assigned = feedbackVersion.toString();
        await tx`
          UPDATE telemetry.interaction_events SET feedback_version=${assigned}::bigint WHERE event_id=${event.event_id}::uuid
        `;
        const payload = buildMlFeedbackEvent(userId, event, assigned);
        await tx`
          INSERT INTO telemetry.ml_outbox (job_type,aggregate_id,idempotency_key,payload)
          VALUES ('feedback',${userId}::uuid,${`feedback:${event.event_id}`},${JSON.stringify(payload)}::jsonb)
          ON CONFLICT (idempotency_key) DO NOTHING
        `;
      }
      if (stateChanged && FEED_INVALIDATING_EVENTS.has(event.event_type)) invalidateFeed = true;
      results.set(event.event_id, { event_id: event.event_id, status: 'accepted', ...(assigned ? { feedback_version: assigned } : {}) });
    }

    if (invalidateFeed) feedVersion += 1n;
    await tx`
      UPDATE app.user_feed_state SET feed_version=${feedVersion.toString()}::bigint,
        feedback_version=${feedbackVersion.toString()}::bigint,updated_at=now() WHERE user_id=${userId}::uuid
    `;
    const ordered = events.map((event) => results.get(event.event_id)!);
    return {
      accepted: ordered.filter((result) => result.status === 'accepted').length,
      duplicates: ordered.filter((result) => result.status === 'duplicate').length,
      feed_version: feedVersion.toString(),
      results: ordered,
    };
}

export async function processInteractionBatchV2(
  userId: string,
  events: InteractionEventV2[],
): Promise<InteractionBatchResultV2> {
  return sqlClient.begin((tx) => processInteractionBatchV2InTransaction(tx, userId, events));
}
