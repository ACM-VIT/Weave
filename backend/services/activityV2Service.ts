import { lockModelLane, enqueueModelFeedback, touchCurrentIntentPresence } from './modelOperationService.js';
import { withOutboxTrace } from '../observability/tracing.js';
import {
  FEED_INVALIDATING_EVENTS,
  ML_RELEVANT_EVENTS,
  type InteractionBatchResultV2,
  type InteractionEventType,
  type InteractionEventV2,
} from '../contracts/interactions.v2.js';
import { FEEDBACK_WEIGHTS } from '../config/feedback.js';
import { isDeepStrictEqual } from 'node:util';
import { sqlClient } from '../db/index.js';
import type postgres from 'postgres';
import { buildMlFeedbackEvent } from './mlFeedbackPayloadService.js';
import {
  getRepositoryMembershipSavedState,
  setRepositorySaved,
} from './savedRepositoryService.js';

export type ReactionState = 'like' | 'dislike' | null;

export function isMembershipManagedSaveEvent(event: InteractionEventV2): boolean {
  return (event.event_type === 'save' || event.event_type === 'unsave')
    && event.context.save_state_source === 'list_membership';
}

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

function sameEvent(row: Record<string, unknown>, event: InteractionEventV2, userId: string): boolean {
  return (row.impression_event_id==null?null:String(row.impression_event_id))===(event.impression_event_id??null)
    && String(row.user_id) === userId && String(row.session_id) === event.session_id
    && (row.serve_id == null ? null : String(row.serve_id)) === event.serve_id
    && String(row.repo_id) === event.repo_id
    && (row.position == null ? null : Number(row.position)) === event.position
    && row.event_type === event.event_type
    && (row.dwell_ms == null ? null : Number(row.dwell_ms)) === event.dwell_ms
    && new Date(row.client_occurred_at as string).toISOString() === new Date(event.client_occurred_at).toISOString()
    && isDeepStrictEqual(row.context, event.context);
}

export async function processInteractionBatchV2InTransaction(
  tx: postgres.TransactionSql,
  userId: string,
  events: InteractionEventV2[],
): Promise<InteractionBatchResultV2> {
  const suppliedIds = events.map(event => event.event_id);
  userId = userId.toLowerCase();
  events = events.map(event => ({ ...event, event_id: event.event_id.toLowerCase(), repo_id: event.repo_id.toLowerCase(),
    session_id: event.session_id.toLowerCase(), serve_id: event.serve_id?.toLowerCase() ?? null,
    ...('impression_event_id' in event?{impression_event_id:event.impression_event_id?.toLowerCase()??null}:{}) }));
  // Profile/persona changes lock user first, then feed: preserve that order.
  await tx`SELECT user_id FROM app.users WHERE user_id=${userId}::uuid FOR KEY SHARE`;
  await tx`INSERT INTO app.user_feed_state (user_id) VALUES (${userId}::uuid) ON CONFLICT (user_id) DO NOTHING`;
  const states = await tx`SELECT feed_version,feedback_version FROM app.user_feed_state WHERE user_id=${userId}::uuid FOR UPDATE`;
  if (states.length === 0) throw new Error('User feed state is unavailable.');
  const modelLane = await lockModelLane(tx, userId);
  let feedVersion = BigInt(states[0].feed_version);
  let feedbackVersion = BigInt(states[0].feedback_version);
  let invalidateFeed = false;
  const results: InteractionBatchResultV2['results'] = [];
  const unique = new Map<string, InteractionEventV2>();
  for (const event of events) {
    const previous = unique.get(event.event_id);
    if (previous && !sameEvent({ ...previous, user_id: userId }, event, userId)) {
      throw new Error(`Event ${event.event_id} was reused with different content.`);
    }
    if (!previous) unique.set(event.event_id, event);
  }
  const inputs = [...unique.values()];
  const attributed = inputs.filter(event => event.serve_id !== null);
  if (attributed.length) {
    const invalid = await tx`
      SELECT input.event_id FROM jsonb_to_recordset(${JSON.stringify(attributed)}::jsonb)
        AS input(event_id uuid,serve_id uuid,repo_id uuid,position integer)
      LEFT JOIN telemetry.feed_serves serve ON serve.serve_id=input.serve_id AND serve.user_id=${userId}::uuid
      LEFT JOIN telemetry.feed_serve_items item ON item.serve_id=serve.serve_id
        AND item.repo_id=input.repo_id AND item.position=input.position
      WHERE item.serve_id IS NULL LIMIT 1
    `;
    if (invalid.length) throw new Error(`Event ${invalid[0].event_id} does not match its serve item.`);
  }

  // Insert IDs in deterministic order for cross-user collisions. Product
  // transitions and feedback versions below still follow original client order.
  const inserted = inputs.length ? await tx`
    INSERT INTO telemetry.interaction_events (
      event_id,schema_version,user_id,session_id,serve_id,repo_id,position,event_type,dwell_ms,client_occurred_at,context,impression_event_id
    ) SELECT event_id,2,${userId}::uuid,session_id,serve_id,repo_id,position,event_type,dwell_ms,client_occurred_at,context,impression_event_id
      FROM jsonb_to_recordset(${JSON.stringify(inputs)}::jsonb) AS input(
        event_id uuid,session_id uuid,serve_id uuid,repo_id uuid,position smallint,event_type text,
        dwell_ms integer,client_occurred_at timestamptz,context jsonb,impression_event_id uuid
      ) ORDER BY event_id ON CONFLICT (event_id) DO NOTHING RETURNING event_id
  ` : [];
  const accepted = new Set(inserted.map(row => String(row.event_id)));
  const duplicateIds = inputs.filter(event => !accepted.has(event.event_id)).map(event => event.event_id);
  if (duplicateIds.length) {
    const existing = await tx`SELECT event_id,user_id,session_id,serve_id,repo_id,position,event_type,dwell_ms,client_occurred_at,context,impression_event_id
      FROM telemetry.interaction_events WHERE event_id=ANY(${duplicateIds}::uuid[])`;
    const byId = new Map(existing.map(row => [String(row.event_id), row]));
    for (const id of duplicateIds) {
      if (!sameEvent(byId.get(id) ?? {}, unique.get(id)!, userId)) throw new Error(`Event ${id} was reused with different content.`);
    }
  }

  // Only public counters require cross-user repository locks. Passive learning
  // touches user-scoped rows already protected by the feed-state lock above.
  const counterRepos = [...new Set(inputs.filter(event => accepted.has(event.event_id)
    && (FEED_INVALIDATING_EVENTS.has(event.event_type) || event.event_type === 'impression'))
    .map(event => event.repo_id))].sort();
  if (counterRepos.length) {
    await tx`INSERT INTO app.repo_engagement(repo_id) SELECT unnest(${counterRepos}::uuid[]) ON CONFLICT DO NOTHING`;
    await tx`SELECT repo_id FROM app.repo_engagement WHERE repo_id=ANY(${counterRepos}::uuid[]) ORDER BY repo_id FOR UPDATE`;
  }

  const engagement = new Map<string, {
    repo_id: string; impressions: number; readme_opens: number; github_opens: number; shares: number;
    total_dwell_ms: number; feedback_score: number; last_event_at: string;
  }>();
  const feedback: { event_id: string; feedback_version: string; payload: ReturnType<typeof buildMlFeedbackEvent> }[] = [];
  const processed = new Set<string>();
  for (const event of events) {
    if (!accepted.has(event.event_id) || processed.has(event.event_id)) {
      results.push({ event_id: event.event_id, status: 'duplicate' });
      continue;
    }
    processed.add(event.event_id);
    let stateChanged = false;
    if (['like','unlike','dislike','undislike'].includes(event.event_type)) {
      const current = await tx`SELECT reaction FROM app.reactions WHERE user_id=${userId}::uuid AND repo_id=${event.repo_id}::uuid FOR UPDATE`;
      const before = (current[0]?.reaction as ReactionState | undefined) ?? null;
      const after = transitionReaction(before, event.event_type);
      stateChanged = before !== after;
      if (stateChanged) {
        if (after === null) await tx`DELETE FROM app.reactions WHERE user_id=${userId}::uuid AND repo_id=${event.repo_id}::uuid`;
        else await tx`INSERT INTO app.reactions(user_id,repo_id,reaction) VALUES(${userId}::uuid,${event.repo_id}::uuid,${after})
          ON CONFLICT (user_id,repo_id) DO UPDATE SET reaction=EXCLUDED.reaction,updated_at=now()`;
        const likeDelta = Number(after === 'like') - Number(before === 'like');
        const dislikeDelta = Number(after === 'dislike') - Number(before === 'dislike');
        await tx`UPDATE app.repo_engagement SET likes_count=GREATEST(0,likes_count+${likeDelta}),
          dislikes_count=GREATEST(0,dislikes_count+${dislikeDelta}),updated_at=now() WHERE repo_id=${event.repo_id}::uuid`;
        await tx`UPDATE app.user_stats SET likes_given_count=GREATEST(0,likes_given_count+${likeDelta}),updated_at=now() WHERE user_id=${userId}::uuid`;
      }
    } else if ((event.event_type === 'save' || event.event_type === 'unsave') && !isMembershipManagedSaveEvent(event)) {
      const membershipSaved = await getRepositoryMembershipSavedState(tx, userId, event.repo_id);
      stateChanged = await setRepositorySaved(tx, userId, event.repo_id, membershipSaved, { engagementLocked: true });
    }
    let delta = engagement.get(event.repo_id);
    if (!delta) {
      delta = { repo_id: event.repo_id, impressions: 0, readme_opens: 0, github_opens: 0, shares: 0,
        total_dwell_ms: 0, feedback_score: 0, last_event_at: event.client_occurred_at };
      engagement.set(event.repo_id, delta);
    }
    if (event.event_type === 'impression') delta.impressions++;
    if (event.event_type === 'readme_open') delta.readme_opens++;
    if (event.event_type === 'github_open') delta.github_opens++;
    if (event.event_type === 'share') delta.shares++;
    delta.total_dwell_ms += event.dwell_ms ?? 0;
    delta.feedback_score += scoreFor(event);
    if (new Date(event.client_occurred_at) > new Date(delta.last_event_at)) delta.last_event_at = event.client_occurred_at;
    let assigned: string | undefined;
    if (ML_RELEVANT_EVENTS.has(event.event_type)) {
      assigned = (++feedbackVersion).toString();
      feedback.push({ event_id: event.event_id, feedback_version: assigned, payload: buildMlFeedbackEvent(userId, event, assigned) });
    }
    if (stateChanged && FEED_INVALIDATING_EVENTS.has(event.event_type)) invalidateFeed = true;
    results.push({ event_id: event.event_id, status: 'accepted', ...(assigned ? { feedback_version: assigned } : {}) });
  }
  const deltas = [...engagement.values()];
  const impressions = deltas.filter(row => row.impressions > 0);
  if (impressions.length) await tx`UPDATE app.repo_engagement target SET views_count=target.views_count+input.impressions,updated_at=now()
    FROM jsonb_to_recordset(${JSON.stringify(impressions)}::jsonb) AS input(repo_id uuid,impressions bigint) WHERE target.repo_id=input.repo_id`;
  if (deltas.length) await tx`
    INSERT INTO telemetry.user_repo_engagement(user_id,repo_id,impressions,readme_opens,github_opens,shares,total_dwell_ms,feedback_score,last_event_at)
    SELECT ${userId}::uuid,repo_id,impressions,readme_opens,github_opens,shares,total_dwell_ms,feedback_score,last_event_at
    FROM jsonb_to_recordset(${JSON.stringify(deltas)}::jsonb) AS input(repo_id uuid,impressions integer,readme_opens integer,
      github_opens integer,shares integer,total_dwell_ms bigint,feedback_score double precision,last_event_at timestamptz)
    ON CONFLICT (user_id,repo_id) DO UPDATE SET
      impressions=telemetry.user_repo_engagement.impressions+EXCLUDED.impressions,
      readme_opens=telemetry.user_repo_engagement.readme_opens+EXCLUDED.readme_opens,
      github_opens=telemetry.user_repo_engagement.github_opens+EXCLUDED.github_opens,
      shares=telemetry.user_repo_engagement.shares+EXCLUDED.shares,
      total_dwell_ms=telemetry.user_repo_engagement.total_dwell_ms+EXCLUDED.total_dwell_ms,
      feedback_score=telemetry.user_repo_engagement.feedback_score+EXCLUDED.feedback_score,
      last_event_at=GREATEST(telemetry.user_repo_engagement.last_event_at,EXCLUDED.last_event_at)
  `;
  if (feedback.length) {
    await tx`UPDATE telemetry.interaction_events target SET feedback_version=input.feedback_version
      FROM jsonb_to_recordset(${JSON.stringify(feedback)}::jsonb) AS input(event_id uuid,feedback_version bigint) WHERE target.event_id=input.event_id`;
    if (modelLane) {
      for (const row of feedback) await enqueueModelFeedback(tx,modelLane,row.event_id,row.feedback_version,JSON.stringify(row.payload),unique.get(row.event_id)!.serve_id);
    } else await tx`INSERT INTO telemetry.ml_outbox(job_type,aggregate_id,idempotency_key,payload)
      SELECT 'feedback',${userId}::uuid,'feedback:' || event_id::text,payload
      FROM jsonb_to_recordset(${JSON.stringify(feedback.map(row => ({ ...row, payload: withOutboxTrace(row.payload) })))}::jsonb) AS input(event_id uuid,payload jsonb)
      ON CONFLICT (idempotency_key) DO NOTHING`;
  }
  if(modelLane){
    const currentServes=[...new Set(inputs.filter(event=>accepted.has(event.event_id)&&event.serve_id!==null).map(event=>event.serve_id!))];
    await touchCurrentIntentPresence(tx,modelLane,currentServes);
  }
  if (invalidateFeed) feedVersion++;
  await tx`UPDATE app.user_feed_state SET feed_version=${feedVersion.toString()}::bigint,
    feedback_version=${feedbackVersion.toString()}::bigint,updated_at=now() WHERE user_id=${userId}::uuid`;
  return { accepted: results.filter(row => row.status === 'accepted').length,
    duplicates: results.filter(row => row.status === 'duplicate').length, feed_version: feedVersion.toString(),
    results: results.map((row, index) => ({ ...row, event_id: suppliedIds[index] })) };
}

export async function processInteractionBatchV2(
  userId: string,
  events: InteractionEventV2[],
): Promise<InteractionBatchResultV2> {
  return sqlClient.begin((tx) => processInteractionBatchV2InTransaction(tx, userId, events));
}
