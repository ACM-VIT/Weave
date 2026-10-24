/** Private administrative export DTOs; never part of public repository/feed DTOs. */
export interface ScoringExportPolicy {
  policyId: string;
  policyVersion: string;
  snapshotTtlSeconds: number;
  labelHorizonSeconds: number;
  lateArrivalSeconds: number;
  clockSkewSeconds: number;
  labelerVersion: 'scoring-labels-v1'|'scoring-labels-v2';
}

export interface ScoringExportSelection {
  subjectUserId: string;
  servedFrom: string;
  servedTo: string;
}

export interface FrozenScoringEvent {
  raw_session_id: string | null;
  session_attribution: 'matches_serve' | 'differs_from_serve' | 'not_recorded';
  event_id: string;
  impression_event_id?: string|null;
  impression_linkage?: 'not_recorded'|'resolved_exact'|'unresolved_at_cutoff'|'invalid_attribution';
  user_id: string;
  serve_id: string;
  repo_id: string;
  position: number;
  event_type: string;
  dwell_ms: number | null;
  feedback_version: string | null;
  client_occurred_at: string;
  server_received_at: string;
}

export interface FrozenScoringExposure {
  user_id: string;
  serve_id: string;
  repo_id: string;
  position: number;
  session_id: string;
  exposure_id: string | null;
  served_at: string;
  generation_id: string | null;
  legacy_generation_hint: string | null;
  record_digest: string | null;
  source_status: 'captured' | 'not_captured' | 'legacy_unknown' | 'provenance_unavailable';
  source_expires_at: string | null;
  events: readonly FrozenScoringEvent[];
}

export interface TemporalScoringLabels {
  labeler_version: 'scoring-labels-v1'|'scoring-labels-v2';
  attribution_method: 'serve_tuple_v1'|'original_impression_v2';
  original_client_impression_linkage: 'not_recorded'|'recorded_per_event';
  impression_links?: readonly {event_id:string;impression_event_id:string|null;status:NonNullable<FrozenScoringEvent['impression_linkage']>}[];
  observation_completeness: 'cutoff_observed';
  observed_at: string;
  selected_impression_event_id: string | null;
  observed_impression_event_ids: string[];
  multiple_impressions: boolean;
  outcome_status: 'unobserved' | 'attribution_uncertain' | 'clock_uncertain' | 'unsupported_events' | 'positive_observed'
    | 'explicit_negative_observed' | 'inverse_only_observed' | 'no_action_observed_by_cutoff' | 'right_censored';
  right_censored: boolean;
  horizon_end: string | null;
  late_arrival_risk: true;
  action_counts: Readonly<Record<string, number>>;
  invalid_session_event_ids: string[];
  clock_invalid_event_ids: string[];
  unqualified_dwell_event_ids: string[];
  outside_horizon_event_ids: string[];
  unsupported_event_types: string[];
  unavailable_targets: readonly ['starred', 'dismissed', 'follow'];
  product_transition_state: 'not_inferred';
  raw_events: readonly FrozenScoringEvent[];
}

export interface ScoringExportManifest {
  job_id: string;
  principal_id: string;
  subject_user_id: string;
  observed_at: string;
  pg_snapshot: string;
  expires_at: string;
  served_from: string;
  served_to: string;
  policy: ScoringExportPolicy;
  row_count: number;
  event_count: number;
}

export interface ScoringExportPage {
  manifest: ScoringExportManifest;
  rows: readonly { ordinal: number; exposure: FrozenScoringExposure; labels: TemporalScoringLabels;
    input: null | { context_json: string; context_digest: string; snapshot_json: string; input_base64: string;
      binding_sha256: string; stage_json: string; record_digest: string } }[];
  next_after: number | null;
}
export interface ScoringExportPort {
  create(principalId: string, selection: ScoringExportSelection): Promise<ScoringExportManifest>;
  page(principalId: string, jobId: string, after: number, limit: number): Promise<ScoringExportPage>;
  revoke(principalId: string, subjectUserId: string): Promise<{ revoked: true; purge_pending: true }>;
}
