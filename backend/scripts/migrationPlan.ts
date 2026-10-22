export const LEGACY_BASELINE_TAGS = [
  '0000_initial_schema',
  '0001_custom_triggers',
  '0002_add_indexes',
  '0003_container_boards_rls',
  '0004_wonderful_bullseye',
  '0005_wise_skrulls',
  '0006_sad_cobalt_man',
  '0007_add_user_feedback',
] as const;

// These migrations were merged into the journal with timestamps older than
// the parent branch's already-applied 0007 entry. Drizzle compares against the
// newest recorded timestamp, so parent-history databases need them reconciled
// explicitly before the normal migrator runs.
export const RETROACTIVE_LEGACY_TAGS = [
  '0004_add_likes_given',
  '0005_add_is_saved',
] as const;

// Targeted migrations can record a newer timestamp while earlier required DDL
// is still absent. Normal migration runs first; these idempotent repairs then
// fill any skipped structures and record their hashes.
export const RETROACTIVE_V2_TAGS = [
  '0020_repository_collection_actions',
  '0021_v2_reconciliation_indexes',
  // A targeted README migration may advance history before required profile DDL.
  '0022_repo_owner_github_identity',
  '0023_active_social_profile_handles',
  // A targeted README migration may record 0026 before unrelated Search DDL.
  '0025_repository_summary_artifacts',
  '0024_explore_search',
] as const;

// Some parent environments contain the full v2 structures but were created
// before their exact SQL hashes entered the shared Drizzle journal. These may
// be adopted only after migrate.ts verifies the corresponding structures.
export const STRUCTURALLY_ADOPTABLE_V2_TAGS = [
  '0008_interaction_events_and_saved_counts',
  '0009_app_telemetry_baseline',
  '0010_product_api_baseline',
  '0011_interaction_feedback_grant',
  '0012_remove_profile_length_limits',
  '0013_feed_serve_cursor',
] as const;
