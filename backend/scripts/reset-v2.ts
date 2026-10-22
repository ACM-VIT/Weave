import 'dotenv/config';
import postgres from 'postgres';

if (process.env.RESET_V2_DATABASE !== 'I_UNDERSTAND_THIS_DELETES_DATA') {
  throw new Error('Set RESET_V2_DATABASE=I_UNDERSTAND_THIS_DELETES_DATA to continue.');
}
if (process.env.ALLOW_REMOTE_DATABASE_RESET !== '1') {
  throw new Error('Set ALLOW_REMOTE_DATABASE_RESET=1 after verifying DATABASE_URL points at the intended database.');
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');

const sql = postgres(databaseUrl, { max: 1, prepare: false });
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(`TRUNCATE TABLE
      telemetry.generation_attempts, telemetry.ml_outbox, telemetry.user_repo_engagement,
      telemetry.interaction_events, telemetry.feed_serve_items, telemetry.feed_serves, telemetry.sessions,
      app.trending_snapshot_items, app.trending_snapshots, app.board_repos, app.boards,
      app.board_collections, app.comments, app.follows, app.saves, app.reactions,
      app.repo_card_summaries, app.repo_topics, app.repo_engagement, app.repo_stat_snapshots,
      app.repo_content, app.repos, app.user_topics, app.topics, app.oauth_codes,
      app.refresh_tokens, app.user_feed_state, app.user_stats, app.users
      RESTART IDENTITY CASCADE`);
    await tx`UPDATE telemetry.counter_reconciliation_progress
      SET last_id=NULL,upper_id=NULL,completed_sweeps=0,updated_at=now()`;
  });
  console.log('Canonical app and telemetry data cleared. Supabase auth.users was not modified.');
} finally {
  await sql.end();
}
