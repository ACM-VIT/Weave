import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const appSchema = pgSchema('app');
export const telemetrySchema = pgSchema('telemetry');

export const appUsers = appSchema.table('users', {
  userId: uuid('user_id').primaryKey(),
  username: varchar('username', { length: 50 }).notNull(),
  fullName: varchar('full_name', { length: 100 }),
  dateOfBirth: date('date_of_birth', { mode: 'string' }),
  bio: text('bio'),
  githubId: text('github_id'),
  githubHandle: text('github_handle'),
  githubIdentityVerifiedAt: timestamp('github_identity_verified_at', { withTimezone: true }),
  avatarUrl: text('avatar_url'),
  interests: jsonb('interests').$type<string[]>().notNull().default([]),
  skills: jsonb('skills').$type<string[]>().notNull().default([]),
  techStack: jsonb('tech_stack').$type<string[]>().notNull().default([]),
  onboardingCompleted: boolean('onboarding_completed').notNull().default(false),
  status: text('status').notNull().default('active'),
  profileVersion: bigint('profile_version', { mode: 'bigint' }).notNull().default(1n),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('app_users_username_lower_uidx').on(sql`lower(${table.username})`),
  uniqueIndex('app_users_verified_github_id_uidx')
    .on(table.githubId)
    .where(sql`${table.githubIdentityVerifiedAt} IS NOT NULL AND ${table.githubId} IS NOT NULL`),
  check('app_users_status_check', sql`${table.status} IN ('active','suspended','deleted')`),
]);

export const userStats = appSchema.table('user_stats', {
  userId: uuid('user_id').primaryKey().references(() => appUsers.userId, { onDelete: 'cascade' }),
  followersCount: integer('followers_count').notNull().default(0),
  followingCount: integer('following_count').notNull().default(0),
  likesGivenCount: integer('likes_given_count').notNull().default(0),
  savedReposCount: integer('saved_repos_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userFeedState = appSchema.table('user_feed_state', {
  userId: uuid('user_id').primaryKey().references(() => appUsers.userId, { onDelete: 'cascade' }),
  feedVersion: bigint('feed_version', { mode: 'bigint' }).notNull().default(1n),
  feedbackVersion: bigint('feedback_version', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const appRefreshTokens = appSchema.table('refresh_tokens', {
  tokenId: uuid('token_id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => [index('app_refresh_tokens_user_idx').on(table.userId)]);

export const appOauthCodes = appSchema.table('oauth_codes', {
  code: uuid('code').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  clientCodeChallenge: text('client_code_challenge'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const topics = appSchema.table('topics', {
  topicId: bigserial('topic_id', { mode: 'number' }).primaryKey(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
});

export const userTopics = appSchema.table('user_topics', {
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  topicId: bigint('topic_id', { mode: 'number' }).notNull().references(() => topics.topicId, { onDelete: 'cascade' }),
  strength: doublePrecision('strength').notNull().default(1),
}, (table) => [primaryKey({ columns: [table.userId, table.topicId] })]);

export const appRepos = appSchema.table('repos', {
  repoId: uuid('repo_id').defaultRandom().primaryKey(),
  githubId: bigint('github_id', { mode: 'bigint' }).notNull().unique(),
  githubNodeId: text('github_node_id'),
  fullName: text('full_name').notNull(),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('app_repos_full_name_lower_uidx').on(sql`lower(${table.fullName})`),
  uniqueIndex('app_repos_github_node_id_uidx').on(table.githubNodeId),
  check('app_repos_github_id_positive', sql`${table.githubId} > 0`),
  check('app_repos_status_check', sql`${table.status} IN ('active','archived','deleted','blocked')`),
]);

export const repoContent = appSchema.table('repo_content', {
  repoId: uuid('repo_id').primaryKey().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  description: text('description'),
  readme: text('readme'),
  primaryLanguage: text('primary_language'),
  languages: jsonb('languages').$type<string[]>().notNull().default([]),
  contentHash: text('content_hash').notNull(),
  contentVersion: integer('content_version').notNull().default(1),
  sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const repoStatSnapshots = appSchema.table('repo_stat_snapshots', {
  snapshotId: uuid('snapshot_id').defaultRandom().primaryKey(),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  starCount: integer('star_count').notNull().default(0),
  forkCount: integer('fork_count').notNull().default(0),
  openIssuesCount: integer('open_issues_count').notNull().default(0),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex('repo_stat_repo_observed_uidx').on(table.repoId, table.observedAt)]);

export const repoEngagement = appSchema.table('repo_engagement', {
  repoId: uuid('repo_id').primaryKey().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  likesCount: integer('likes_count').notNull().default(0),
  dislikesCount: integer('dislikes_count').notNull().default(0),
  savesCount: integer('saves_count').notNull().default(0),
  commentsCount: integer('comments_count').notNull().default(0),
  viewsCount: bigint('views_count', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const repoTopics = appSchema.table('repo_topics', {
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  topicId: bigint('topic_id', { mode: 'number' }).notNull().references(() => topics.topicId, { onDelete: 'cascade' }),
}, (table) => [primaryKey({ columns: [table.repoId, table.topicId] })]);

export const repoCardSummaries = appSchema.table('repo_card_summaries', {
  summaryId: uuid('summary_id').defaultRandom().primaryKey(),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  contentVersion: integer('content_version').notNull(),
  modelVersion: text('model_version').notNull(),
  summary: text('summary').notNull(),
  active: boolean('active').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('repo_card_summaries_repo_active_idx').on(table.repoId, table.active)]);

export const reactions = appSchema.table('reactions', {
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  reaction: text('reaction').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.repoId] }),
  check('reactions_value_check', sql`${table.reaction} IN ('like','dislike')`),
]);

export const saves = appSchema.table('saves', {
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.userId, table.repoId] })]);

export const appFollows = appSchema.table('follows', {
  followerId: uuid('follower_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  followingId: uuid('following_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.followerId, table.followingId] }),
  check('app_follows_no_self', sql`${table.followerId} <> ${table.followingId}`),
]);

export const appComments = appSchema.table('comments', {
  commentId: uuid('comment_id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  parentCommentId: uuid('parent_comment_id'),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const boardCollections = appSchema.table('board_collections', {
  collectionId: uuid('collection_id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const appBoards = appSchema.table('boards', {
  boardId: uuid('board_id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  collectionId: uuid('collection_id').references(() => boardCollections.collectionId, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  visibility: text('visibility').notNull().default('private'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [check('app_boards_visibility_check', sql`${table.visibility} IN ('private','public','unlisted')`)]);

export const appBoardRepos = appSchema.table('board_repos', {
  boardId: uuid('board_id').notNull().references(() => appBoards.boardId, { onDelete: 'cascade' }),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  addedBy: uuid('added_by').references(() => appUsers.userId, { onDelete: 'set null' }),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.boardId, table.repoId] })]);

export const trendingSnapshots = appSchema.table('trending_snapshots', {
  snapshotId: uuid('snapshot_id').primaryKey(),
  period: text('period').notNull(),
  source: text('source').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  complete: boolean('complete').notNull().default(false),
  active: boolean('active').notNull().default(false),
});

export const trendingSnapshotItems = appSchema.table('trending_snapshot_items', {
  snapshotId: uuid('snapshot_id').notNull().references(() => trendingSnapshots.snapshotId, { onDelete: 'cascade' }),
  position: smallint('position').notNull(),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  score: doublePrecision('score'),
  features: jsonb('features').$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  primaryKey({ columns: [table.snapshotId, table.position] }),
  uniqueIndex('trending_snapshot_repo_uidx').on(table.snapshotId, table.repoId),
]);

export const sessions = telemetrySchema.table('sessions', {
  sessionId: uuid('session_id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  platform: text('platform'),
  appVersion: text('app_version'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

export const feedServes = telemetrySchema.table('feed_serves', {
  serveId: uuid('serve_id').defaultRandom().primaryKey(),
  feedRequestId: uuid('feed_request_id').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull(),
  feedVersion: bigint('feed_version', { mode: 'bigint' }).notNull(),
  generationId: uuid('generation_id'),
  source: text('source').notNull(),
  modelVersion: text('model_version'),
  nextCursor: text('next_cursor'),
  status: text('status').notNull().default('prepared'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('feed_serves_user_created_idx').on(table.userId, table.createdAt)]);

export const feedServeItems = telemetrySchema.table('feed_serve_items', {
  serveId: uuid('serve_id').notNull().references(() => feedServes.serveId, { onDelete: 'cascade' }),
  position: smallint('position').notNull(),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId),
  score: doublePrecision('score'),
  source: text('source').notNull(),
  modelVersion: text('model_version'),
  summaryId: uuid('summary_id'),
}, (table) => [
  primaryKey({ columns: [table.serveId, table.position] }),
  uniqueIndex('feed_serve_items_repo_uidx').on(table.serveId, table.repoId),
]);

export const interactionEvents = telemetrySchema.table('interaction_events', {
  eventId: uuid('event_id').primaryKey(),
  schemaVersion: smallint('schema_version').notNull(),
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull(),
  serveId: uuid('serve_id').references(() => feedServes.serveId),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId),
  position: smallint('position'),
  eventType: text('event_type').notNull(),
  dwellMs: integer('dwell_ms'),
  feedbackVersion: bigint('feedback_version', { mode: 'bigint' }),
  clientOccurredAt: timestamp('client_occurred_at', { withTimezone: true }).notNull(),
  serverReceivedAt: timestamp('server_received_at', { withTimezone: true }).notNull().defaultNow(),
  context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  index('interaction_events_user_received_idx').on(table.userId, table.serverReceivedAt),
  index('interaction_events_serve_repo_idx').on(table.serveId, table.repoId),
]);

export const userRepoEngagement = telemetrySchema.table('user_repo_engagement', {
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  impressions: integer('impressions').notNull().default(0),
  readmeOpens: integer('readme_opens').notNull().default(0),
  githubOpens: integer('github_opens').notNull().default(0),
  shares: integer('shares').notNull().default(0),
  totalDwellMs: bigint('total_dwell_ms', { mode: 'bigint' }).notNull().default(0n),
  feedbackScore: doublePrecision('feedback_score').notNull().default(0),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.userId, table.repoId] })]);

export const mlOutbox = telemetrySchema.table('ml_outbox', {
  outboxId: uuid('outbox_id').defaultRandom().primaryKey(),
  jobType: text('job_type').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimToken: uuid('claim_token'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('ml_outbox_ready_idx').on(table.status, table.availableAt)]);

export const generationAttempts = telemetrySchema.table('generation_attempts', {
  generationId: uuid('generation_id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  feedVersion: bigint('feed_version', { mode: 'bigint' }).notNull(),
  mode: text('mode').notNull(),
  status: text('status').notNull(),
  latencyMs: integer('latency_ms'),
  resultCount: integer('result_count'),
  errorCode: text('error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
