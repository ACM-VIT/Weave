import type { FrozenScoringEvent, FrozenScoringExposure, ScoringExportPolicy, TemporalScoringLabels } from '../contracts/scoringExport.js';
import { validateScoringExportPolicy } from '../config/scoringExport.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const types = new Set(['impression','dwell','readme_open','github_open','share','like','unlike','dislike','undislike','save','unsave']);
const positives = new Set(['dwell','readme_open','github_open','share','like','save']);
const inverses = new Set(['unlike','undislike','unsave']);

export class ScoringExportInputError extends Error {
  constructor() { super('SCORING_EXPORT_INPUT_INVALID'); this.name = 'ScoringExportInputError'; }
}
const invalid = (): never => { throw new ScoringExportInputError(); };

/** PostgreSQL timestamps, including their microseconds; no JS millisecond tie loss. */
export function exportTimestampMicros(value: string): bigint {
  if (typeof value !== 'string') return invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(value);
  if (!match || match[1] === '0000') return invalid();
  const base = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const time = new Date(base);
  if (!Number.isFinite(time.getTime()) || [time.getUTCFullYear(),time.getUTCMonth()+1,time.getUTCDate(),time.getUTCHours(),time.getUTCMinutes(),time.getUTCSeconds()]
    .some((part,index) => part !== Number(match[index+1]))) return invalid();
  return BigInt(time.getTime()) * 1000n + BigInt((match[7] ?? '').padEnd(6,'0') || '0');
}
function microsTimestamp(value: bigint): string {
  const remainder = ((value % 1_000_000n) + 1_000_000n) % 1_000_000n;
  const seconds = (value - remainder) / 1_000_000n;
  return new Date(Number(seconds * 1000n)).toISOString().slice(0,19) + '.' + String(remainder).padStart(6,'0') + 'Z';
}

function validateEvent(event: FrozenScoringEvent, row: FrozenScoringExposure,v2:boolean): void {
  if (Object.keys(event).sort().join(',') !== ['client_occurred_at','dwell_ms','event_id','event_type','feedback_version','position','raw_session_id','repo_id','serve_id','server_received_at','session_attribution','user_id',...(v2?['impression_event_id','impression_linkage']:[])].sort().join(',')
    || !(event.raw_session_id===null||(typeof event.raw_session_id==='string'&&uuid.test(event.raw_session_id)))
    || event.session_attribution!==(event.raw_session_id===null?'not_recorded':event.raw_session_id===row.session_id?'matches_serve':'differs_from_serve')
    || !uuid.test(event.event_id) || event.user_id !== row.user_id || event.serve_id !== row.serve_id
    || event.repo_id !== row.repo_id || event.position !== row.position
    || typeof event.event_type !== 'string' || event.event_type.length < 1 || event.event_type.length > 64
    || !(event.dwell_ms === null || (Number.isInteger(event.dwell_ms) && event.dwell_ms >= 0 && event.dwell_ms <= 300_000))
    || !(event.feedback_version === null || (typeof event.feedback_version === 'string'
      && /^[1-9][0-9]{0,18}$/.test(event.feedback_version) && BigInt(event.feedback_version) <= 9_223_372_036_854_775_807n))) invalid();
  if(v2&&(!(event.impression_event_id===null||(typeof event.impression_event_id==='string'&&uuid.test(event.impression_event_id)))
    ||!['not_recorded','resolved_exact','unresolved_at_cutoff','invalid_attribution'].includes(event.impression_linkage??'')
    ||(event.impression_event_id===null)!==(event.impression_linkage==='not_recorded')))invalid();
  exportTimestampMicros(event.client_occurred_at); exportTimestampMicros(event.server_received_at);
}

/** Deterministic labels from a FROZEN snapshot, never the current wall clock/model. */
export function labelFrozenScoringExposure(row: FrozenScoringExposure, observedAt: string, policy: ScoringExportPolicy): TemporalScoringLabels {
  validateScoringExportPolicy(policy);
  if (![row.user_id,row.serve_id,row.repo_id,row.session_id].every(value => typeof value === 'string' && uuid.test(value))
    || !Number.isInteger(row.position) || row.position < 0 || row.position > 32767
    || !Array.isArray(row.events) || row.events.length > 5000) invalid();
  const observed = exportTimestampMicros(observedAt), served = exportTimestampMicros(row.served_at);
  if (served > observed) return invalid();
  const v2=policy.labelerVersion==='scoring-labels-v2';
  const seen = new Set<string>();
  for (const event of row.events) { validateEvent(event,row,v2); if (seen.has(event.event_id)) invalid(); seen.add(event.event_id); }
  const events = [...row.events].sort((a,b) => {
    const client = exportTimestampMicros(a.client_occurred_at) - exportTimestampMicros(b.client_occurred_at);
    const receipt = exportTimestampMicros(a.server_received_at) - exportTimestampMicros(b.server_received_at);
    return client < 0n ? -1 : client > 0n ? 1 : receipt < 0n ? -1 : receipt > 0n ? 1 : a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });
  const byId=new Map(events.map(event=>[event.event_id,event]));
  const impressionLinks:NonNullable<TemporalScoringLabels['impression_links']>=v2?events.filter(event=>event.event_type!=='impression').map(event=>{
    if(event.impression_linkage==='resolved_exact'){
      const original=byId.get(event.impression_event_id!);
      if(!original||original.event_type!=='impression'||original.user_id!==event.user_id||original.repo_id!==event.repo_id
        ||original.serve_id!==event.serve_id||original.position!==event.position||original.raw_session_id!==event.raw_session_id
        ||original.session_attribution!=='matches_serve'||event.session_attribution!=='matches_serve'
        ||exportTimestampMicros(original.client_occurred_at)>exportTimestampMicros(event.client_occurred_at))invalid();
    }
    return{event_id:event.event_id,impression_event_id:event.impression_event_id!,status:event.impression_linkage!};
  }):[];
  const unlinkedActions=new Set(impressionLinks.filter(link=>link.status!=='resolved_exact').map(link=>link.event_id));
  const skew = BigInt(policy.clockSkewSeconds) * 1_000_000n;
  const clockInvalid = events.filter(event => {
    const client = exportTimestampMicros(event.client_occurred_at), receipt = exportTimestampMicros(event.server_received_at);
    return client < served - skew || receipt < served - skew || client > receipt + skew || receipt > observed;
  });
  const clockInvalidIds = new Set(clockInvalid.map(event => event.event_id));
  const invalidSession = events.filter(event=>event.session_attribution!=='matches_serve');
  const invalidSessionIds=new Set(invalidSession.map(event=>event.event_id));
  const valid = events.filter(event => !clockInvalidIds.has(event.event_id)&&!invalidSessionIds.has(event.event_id)&&!unlinkedActions.has(event.event_id));
  const impressions = valid.filter(event => event.event_type === 'impression');
  const anchor = impressions[0] ? exportTimestampMicros(impressions[0].client_occurred_at) : null;
  const end = anchor === null ? null : anchor + BigInt(policy.labelHorizonSeconds) * 1_000_000n;
  const mature = end !== null && observed >= end + BigInt(policy.lateArrivalSeconds) * 1_000_000n;
  const inWindow = end === null ? [] : valid.filter(event => {
    const time = exportTimestampMicros(event.client_occurred_at);
    return event.event_type !== 'impression' && time >= anchor! && time <= end;
  });
  const unqualified = inWindow.filter(event => event.event_type === 'dwell' && (event.dwell_ms ?? 0) < 3000);
  const unqualifiedIds = new Set(unqualified.map(event => event.event_id));
  const counts: Record<string,number> = Object.fromEntries([...types].filter(type => type !== 'impression').map(type => [type,0]));
  for (const event of inWindow) if (types.has(event.event_type) && !unqualifiedIds.has(event.event_id)) counts[event.event_type]++;
  const unsupported = [...new Set(events.filter(event => !types.has(event.event_type)).map(event => event.event_type))].sort();
  let status: TemporalScoringLabels['outcome_status'];
  if (invalidSession.length||unlinkedActions.size) status='attribution_uncertain';
  else if (clockInvalid.length) status = 'clock_uncertain';
  else if (unsupported.length) status = 'unsupported_events';
  else if (anchor === null) status = 'unobserved';
  else if ([...positives].some(type => counts[type] > 0)) status = 'positive_observed';
  else if (counts.dislike > 0) status = 'explicit_negative_observed';
  else if ([...inverses].some(type => counts[type] > 0)) status = 'inverse_only_observed';
  else status = mature ? 'no_action_observed_by_cutoff' : 'right_censored';
  return { labeler_version:policy.labelerVersion, attribution_method:v2?'original_impression_v2':'serve_tuple_v1',
    original_client_impression_linkage:v2?'recorded_per_event':'not_recorded',...(v2?{impression_links:impressionLinks}:{}), observation_completeness: 'cutoff_observed', observed_at: observedAt,
    selected_impression_event_id: impressions[0]?.event_id ?? null, observed_impression_event_ids: impressions.map(event => event.event_id),
    multiple_impressions: impressions.length > 1, outcome_status: status, right_censored: !mature || unlinkedActions.size > 0 || invalidSession.length > 0 || clockInvalid.length > 0 || unsupported.length > 0,
    horizon_end: end === null ? null : microsTimestamp(end), late_arrival_risk: true, action_counts: Object.freeze(counts),
    invalid_session_event_ids: invalidSession.map(event=>event.event_id),
    clock_invalid_event_ids: clockInvalid.map(event => event.event_id), unqualified_dwell_event_ids: unqualified.map(event => event.event_id),
    outside_horizon_event_ids: end === null ? [] : valid.filter(event => event.event_type !== 'impression'
      && (exportTimestampMicros(event.client_occurred_at) < anchor! || exportTimestampMicros(event.client_occurred_at) > end)).map(event => event.event_id),
    unsupported_event_types: unsupported, unavailable_targets: ['starred','dismissed','follow'],
    product_transition_state: 'not_inferred', raw_events: Object.freeze(events) };
}
