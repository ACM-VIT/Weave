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

// These migrations were merged after some environments had already recorded
// newer V2 journal timestamps. Drizzle skips older timestamps, so execute the
// idempotent SQL explicitly before handing control back to the normal migrator.
export const RETROACTIVE_V2_TAGS = [
  '0020_repository_collection_actions',
  '0021_v2_reconciliation_indexes',
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
