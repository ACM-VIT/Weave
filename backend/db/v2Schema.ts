import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const appSchema = pgSchema('app');
export const telemetrySchema = pgSchema('telemetry');

export const counterReconciliationProgress = telemetrySchema.table('counter_reconciliation_progress', {
  scope: text('scope').primaryKey(),
  lastId: uuid('last_id'),
  upperId: uuid('upper_id'),
  completedSweeps: bigint('completed_sweeps', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('counter_reconciliation_scope_check', sql`${table.scope} IN ('repositories','users')`),
  check('counter_reconciliation_sweeps_check', sql`${table.completedSweeps} >= 0`),
  check('counter_reconciliation_cursor_check', sql`${table.lastId} IS NULL OR (${table.upperId} IS NOT NULL AND ${table.lastId} <= ${table.upperId})`),
]);

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
  onboardingTaxonomy: jsonb('onboarding_taxonomy').$type<Record<string, unknown>>().notNull().default({}),
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
  check('app_users_onboarding_taxonomy_object', sql`jsonb_typeof(${table.onboardingTaxonomy})='object' AND octet_length(${table.onboardingTaxonomy}::text)<=32768`),
]);

export const userGithubImports = appSchema.table('user_github_imports', {
  userId: uuid('user_id').primaryKey().references(() => appUsers.userId, { onDelete: 'cascade' }),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(0n),
  githubId: text('github_id'), snapshotId: uuid('snapshot_id'), snapshotHash: text('snapshot_hash'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  collectToken: uuid('collect_token'), collectUntil: timestamp('collect_until', { withTimezone: true }),
  lastCollectedAt: timestamp('last_collected_at', { withTimezone: true }),
  consentedAt: timestamp('consented_at', { withTimezone: true }), acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedProfileVersion: bigint('accepted_profile_version', { mode: 'bigint' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  provenance: jsonb('provenance').notNull().default({}), baseline: jsonb('baseline').notNull().default({}), applied: jsonb('applied').notNull().default({}),
});

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
  lastPublishedFeedVersion: bigint('last_published_feed_version', { mode: 'bigint' }).notNull().default(0n),
  feedbackVersion: bigint('feedback_version', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  modelOperationVersion: bigint('model_operation_version',{mode:'bigint'}).notNull().default(0n),
  modelAcceptedAtMs: bigint('model_accepted_at_ms',{mode:'bigint'}).notNull().default(0n),
  modelPolicySha256: text('model_policy_sha256'), modelPolicyLimits: jsonb('model_policy_limits'),
  modelInitialized: boolean('model_initialized').notNull().default(false),
});

export const feedPrewarmJobs = telemetrySchema.table('feed_prewarm_jobs', {
  userId: uuid('user_id').primaryKey().references(() => appUsers.userId, { onDelete: 'cascade' }),
  feedVersion: bigint('feed_version', { mode: 'bigint' }).notNull(),
  profileVersion: bigint('profile_version', { mode: 'bigint' }).notNull(),
  status: text('status').notNull().default('pending'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimToken: uuid('claim_token'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
}, table => [
  index('feed_prewarm_ready_idx').on(table.availableAt, table.userId).where(sql`${table.status} IN ('pending','claimed')`),
  index('feed_prewarm_expiry_idx').on(table.scheduledAt, table.userId).where(sql`${table.status} IN ('pending','claimed')`),
  check('feed_prewarm_status_check', sql`${table.status} IN ('pending','claimed','completed','expired')`),
  check('feed_prewarm_attempts_check', sql`${table.attempts} >= 0`),
  check('feed_prewarm_claim_check', sql`(${table.status}='claimed' AND ${table.claimedAt} IS NOT NULL AND ${table.claimToken} IS NOT NULL)
    OR (${table.status}<>'claimed' AND ${table.claimedAt} IS NULL AND ${table.claimToken} IS NULL)`),
]);

export const socialProfiles = appSchema.table('social_profiles', {
  profileId: uuid('profile_id').defaultRandom().primaryKey(),
  provider: text('provider').notNull().default('github'),
  providerSubject: text('provider_subject'),
  handle: text('handle').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  profileKind: text('profile_kind').notNull().default('unknown'),
  claimedByUserId: uuid('claimed_by_user_id').references(() => appUsers.userId, { onDelete: 'set null' }),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('social_profiles_provider_subject_uidx')
    .on(table.provider, table.providerSubject)
    .where(sql`${table.providerSubject} IS NOT NULL`),
  index('social_profiles_github_numeric_subject_idx')
    .on(sql`ltrim(${table.providerSubject},'0')`)
    .where(sql`${table.provider}='github'`),
  uniqueIndex('social_profiles_provider_handle_uidx')
    .on(table.provider, sql`lower(${table.handle})`)
    .where(sql`${table.status}='active'`),
  uniqueIndex('social_profiles_claimed_user_uidx')
    .on(table.claimedByUserId)
    .where(sql`${table.claimedByUserId} IS NOT NULL`),
  index('social_profiles_active_handle_idx')
    .on(sql`lower(${table.handle})`)
    .where(sql`${table.status}='active'`),
  check('social_profiles_provider_check', sql`${table.provider} IN ('github')`),
  check('social_profiles_subject_check', sql`${table.providerSubject} IS NULL OR ${table.providerSubject} ~ '^[0-9]{1,30}$'`),
  check('social_profiles_handle_check', sql`${table.handle} ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'`),
  check('social_profiles_kind_check', sql`${table.profileKind} IN ('user','organization','unknown')`),
  check('social_profiles_status_check', sql`${table.status} IN ('active','blocked','deleted')`),
]);

export const socialProfileFollows = appSchema.table('social_profile_follows', {
  followerId: uuid('follower_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull().references(() => socialProfiles.profileId, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.followerId, table.profileId] }),
  index('social_profile_follows_profile_idx').on(table.profileId, table.createdAt.desc()),
  index('social_profile_follows_follower_idx').on(table.followerId, table.createdAt.desc()),
]);

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
  ownerGithubId: bigint('owner_github_id', { mode: 'bigint' }),
  isFork: boolean('is_fork'),
  forkParentGithubId: bigint('fork_parent_github_id', { mode: 'bigint' }),
  forkFamilyGithubId: bigint('fork_family_github_id', { mode: 'bigint' }),
  lineageObservedAt: timestamp('lineage_observed_at', { withTimezone: true, mode: 'string' }),
  lineageSource: text('lineage_source'),
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
  index('app_repos_owner_github_id_idx').on(table.ownerGithubId),
  index('app_repos_owner_active_recent_idx').on(table.ownerGithubId, table.updatedAt.desc(), table.repoId)
    .where(sql`${table.status}='active' AND ${table.ownerGithubId} IS NOT NULL`),
  check('app_repos_github_id_positive', sql`${table.githubId} > 0`),
  check('app_repos_owner_github_id_positive', sql`${table.ownerGithubId} IS NULL OR ${table.ownerGithubId} > 0`),
  check('app_repos_lineage_identity_check', sql`
    (${table.forkParentGithubId} IS NULL OR ${table.forkParentGithubId}>0)
    AND (${table.forkFamilyGithubId} IS NULL OR ${table.forkFamilyGithubId}>0)
    AND (${table.isFork} IS NOT NULL OR (${table.forkParentGithubId} IS NULL AND ${table.forkFamilyGithubId} IS NULL))
    AND (${table.isFork} IS DISTINCT FROM false OR (${table.forkParentGithubId} IS NULL
      AND (${table.forkFamilyGithubId} IS NULL OR ${table.forkFamilyGithubId}=${table.githubId})))
    AND (${table.isFork} IS DISTINCT FROM true OR ((${table.forkParentGithubId} IS NULL OR ${table.forkParentGithubId}<>${table.githubId})
      AND (${table.forkFamilyGithubId} IS NULL OR ${table.forkFamilyGithubId}<>${table.githubId})))`),
  check('app_repos_lineage_provenance_check', sql`
    (${table.lineageSource} IS NULL)=(${table.lineageObservedAt} IS NULL)
    AND (${table.isFork} IS NULL OR ${table.lineageSource} IS NOT NULL)
    AND (${table.lineageObservedAt} IS NULL OR isfinite(${table.lineageObservedAt}))
    AND (${table.lineageSource} IS NULL OR ${table.lineageSource} IN ('github-graphql-repository','github-rest-repository'))`),
  check('app_repos_status_check' , sql`${table.status} IN ('active','archived','deleted','blocked')`),
]);

export const repoContent = appSchema.table('repo_content', {
  repoId: uuid('repo_id').primaryKey().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  description: text('description'),
  readme: text('readme'),
  readmeSourcePath: text('readme_source_path'),
  readmeDefaultBranch: text('readme_default_branch'),
  readmeBaseUrl: text('readme_base_url'),
  primaryLanguage: text('primary_language'),
  languages: jsonb('languages').$type<string[]>().notNull().default([]),
  contentHash: text('content_hash').notNull(),
  contentVersion: integer('content_version').notNull().default(1),
  sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('repo_content_readme_metadata_check', sql`
    (${table.readmeSourcePath} IS NULL OR (
      btrim(${table.readmeSourcePath}) = ${table.readmeSourcePath}
      AND btrim(${table.readmeSourcePath}) <> ''
      AND char_length(${table.readmeSourcePath}) <= 1024
      AND ${table.readmeSourcePath} !~ '^/'
      AND right(${table.readmeSourcePath},1) <> '/'
      AND position('//' in ${table.readmeSourcePath}) = 0
      AND position(chr(92) in ${table.readmeSourcePath}) = 0
      AND ${table.readmeSourcePath} !~ '(^|/)[.]{1,2}(/|$)'
    ))
    AND (${table.readmeDefaultBranch} IS NULL OR (
      btrim(${table.readmeDefaultBranch}) = ${table.readmeDefaultBranch}
      AND btrim(${table.readmeDefaultBranch}) <> ''
      AND char_length(${table.readmeDefaultBranch}) <= 256
      AND ${table.readmeDefaultBranch} !~ '^/'
      AND right(${table.readmeDefaultBranch},1) <> '/'
      AND position('//' in ${table.readmeDefaultBranch}) = 0
      AND position(chr(92) in ${table.readmeDefaultBranch}) = 0
      AND ${table.readmeDefaultBranch} !~ '(^|/)[.]{1,2}(/|$)'
    ))
    AND (${table.readmeBaseUrl} IS NULL OR (
      char_length(${table.readmeBaseUrl}) <= 2048
      AND ${table.readmeBaseUrl}
        ~ '^https://raw[.]githubusercontent[.]com/[^/[:space:]?#]+/[^/[:space:]?#]+/refs/heads/[^[:space:]?#]+/$'
    ))
  `),
]);

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
}, (table) => [primaryKey({ columns: [table.repoId, table.topicId] }),
  index('app_repo_topics_topic_idx').on(table.topicId, table.repoId)]);

export const repoCardSummaries = appSchema.table('repo_card_summaries', {
  summaryId: uuid('summary_id').defaultRandom().primaryKey(),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  contentVersion: integer('content_version').notNull(),
  promptVersion: text('prompt_version').notNull(),
  modelVersion: text('model_version').notNull(),
  formatVersion: text('format_version').notNull(),
  summary: text('summary').notNull(),
  highlights: jsonb('highlights').$type<string[]>().notNull().default([]),
  summarySource: text('source').notNull(),
  active: boolean('active').notNull().default(false),
  artifactRevision: integer('artifact_revision').notNull().default(0),
  supersedesSummaryId: uuid('supersedes_summary_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('repo_card_summaries_repo_active_idx').on(table.repoId, table.active),
  uniqueIndex('repo_card_summaries_one_active_uidx').on(table.repoId).where(sql`${table.active}`),
  uniqueIndex('repo_card_summaries_revisioned_uidx').on(
    table.repoId,
    table.contentVersion,
    table.promptVersion,
    table.modelVersion,
    table.formatVersion,
    table.artifactRevision,
  ),
  check('repo_card_summaries_revision_check', sql`${table.artifactRevision} >= 0`),
  foreignKey({ name: 'repo_card_summaries_supersedes_summary_id_fkey',
    columns: [table.supersedesSummaryId], foreignColumns: [table.summaryId] }),
  check('repo_card_summaries_active_length_check', sql`
    (${table.summarySource} = 'legacy' AND NOT ${table.active})
    OR (
      ${table.summarySource} <> 'legacy'
      AND char_length(btrim(${table.summary})) BETWEEN 1 AND 360
    )
  `),
  check('repo_card_summaries_versions_check', sql`
    btrim(${table.promptVersion}) <> ''
    AND btrim(${table.modelVersion}) <> ''
    AND btrim(${table.formatVersion}) <> ''
  `),
  check('repo_card_summaries_highlights_check', sql`
    jsonb_typeof(${table.highlights})='array' AND jsonb_array_length(${table.highlights})<=3
  `),
  check('repo_card_summaries_source_check', sql`
    ${table.summarySource} IN ('generated','description_fallback','legacy')
  `),
]);

export const repoReadmeSummaries = appSchema.table('repo_readme_summaries', {
  summaryId: uuid('summary_id').defaultRandom().primaryKey(),
  generationId: uuid('generation_id').notNull().unique('repo_readme_summaries_generation_id_key'),
  repoId: uuid('repo_id').notNull(),
  contentVersion: integer('content_version').notNull(),
  contentHash: text('content_hash').notNull(),
  promptVersion: text('prompt_version').notNull(),
  formatVersion: text('format_version').notNull(),
  modelVersion: text('model_version').notNull(),
  artifact: jsonb('artifact').$type<Record<string, unknown>>().notNull(),
  active: boolean('active').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  foreignKey({name: 'repo_readme_summaries_repo_id_fkey',columns: [table.repoId],foreignColumns: [appRepos.repoId]}).onDelete('cascade'),
  check('repo_readme_summaries_content_version_check', sql`${table.contentVersion} > 0`),
  check('repo_readme_summaries_content_hash_check', sql`btrim(${table.contentHash}) <> ''`),
  check('repo_readme_summaries_prompt_version_check', sql`btrim(${table.promptVersion}) <> ''`),
  check('repo_readme_summaries_format_version_check', sql`btrim(${table.formatVersion}) <> ''`),
  check('repo_readme_summaries_model_version_check', sql`btrim(${table.modelVersion}) <> ''`),
  check('repo_readme_summaries_artifact_check', sql`jsonb_typeof(${table.artifact}) = 'object' AND octet_length(${table.artifact}::text) <= 12000`),
  uniqueIndex('repo_readme_summaries_active_uidx').on(table.repoId).where(sql`${table.active}`),
]);

export const readmeSummaryJobs = telemetrySchema.table('readme_summary_jobs', {
  jobId: uuid('job_id').defaultRandom().primaryKey(),
  generationId: uuid('generation_id').notNull().defaultRandom(),
  repoId: uuid('repo_id').notNull(),
  contentVersion: integer('content_version').notNull(),
  contentHash: text('content_hash').notNull(),
  promptVersion: text('prompt_version').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimToken: uuid('claim_token'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, table => [
  foreignKey({name: 'readme_summary_jobs_repo_id_fkey',columns: [table.repoId],foreignColumns: [appRepos.repoId]}).onDelete('cascade'),
  check('readme_summary_jobs_content_version_check', sql`${table.contentVersion} > 0`),
  check('readme_summary_jobs_status_check', sql`${table.status} IN ('pending','claimed','completed','failed','superseded')`),
  check('readme_summary_jobs_attempts_check', sql`${table.attempts} >= 0`),
  unique('readme_summary_jobs_repo_id_content_version_content_hash_pr_key')
    .on(table.repoId, table.contentVersion, table.contentHash, table.promptVersion),
  index('readme_summary_jobs_pending_idx').on(table.availableAt, table.createdAt)
    .where(sql`${table.status} IN ('pending','claimed')`),
]);

export const reactions = appSchema.table('reactions', {
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  reaction: text('reaction').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.repoId] }),
  index('app_reactions_user_recent_like_idx').on(table.userId, table.updatedAt.desc(), table.repoId)
    .where(sql`${table.reaction}='like'`),
  index('app_reactions_repo_public_like_idx').on(table.repoId, table.userId).where(sql`${table.reaction}='like'`),
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
  index('app_follows_follower_idx').on(table.followerId, table.createdAt.desc()),
  index('app_follows_following_idx').on(table.followingId, table.createdAt.desc()),
  check('follows_no_self', sql`${table.followerId} <> ${table.followingId}`),
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
  icon: text('icon'),
  color: varchar('color', { length: 7 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const collectionRepos = appSchema.table('collection_repos', {
  collectionId: uuid('collection_id').notNull().references(() => boardCollections.collectionId, { onDelete: 'cascade' }),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  addedBy: uuid('added_by').references(() => appUsers.userId, { onDelete: 'set null' }),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.collectionId, table.repoId] })]);

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
}, (table) => [primaryKey({ columns: [table.boardId, table.repoId] }),
  index('app_board_repos_repository_idx').on(table.repoId, table.boardId),
  index('app_board_repos_recent_idx').on(table.boardId, table.addedAt.desc(), table.repoId)]);

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
  intentEpoch: bigint('intent_epoch',{mode:'bigint'}), intentEpochStartedMs: bigint('intent_epoch_started_ms',{mode:'bigint'}),
  intentEpochWitnessSha256: text('intent_epoch_witness_sha256'), intentPolicySha256: text('intent_policy_sha256'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('feed_serves_user_created_idx').on(table.userId, table.createdAt),
  index('feed_serves_user_session_idx').on(table.userId, table.sessionId),
]);

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

export const feedItemProvenance = telemetrySchema.table('feed_item_provenance', {
  serveId: uuid('serve_id').notNull(),
  position: smallint('position').notNull(),
  exposureId: uuid('exposure_id').notNull().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId),
  generationId: uuid('generation_id'),
  legacyGenerationHint: uuid('legacy_generation_hint'),
  recordDigest: text('record_digest'),
  captureStatus: text('capture_status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [
  primaryKey({ columns: [table.serveId,table.position] }),
  uniqueIndex('feed_item_provenance_exposure_key').on(table.exposureId),
  index('feed_item_provenance_owner_created_idx').on(table.userId,table.createdAt,table.exposureId),
  index('feed_item_provenance_generation_owner_idx').on(table.generationId,table.userId).where(sql`${table.captureStatus}='captured'`),
  foreignKey({name:'feed_item_provenance_parent_fkey',columns:[table.serveId,table.position],
    foreignColumns:[feedServeItems.serveId,feedServeItems.position]}).onDelete('cascade'),
  check('feed_item_provenance_legacy_check',sql`${table.captureStatus}<>'captured' OR ${table.legacyGenerationHint} IS NULL`),
  check('feed_item_provenance_capture_check', sql`(${table.captureStatus}='captured' AND ${table.generationId} IS NOT NULL AND ${table.recordDigest} IS NOT NULL AND ${table.recordDigest} ~ '^[a-f0-9]{64}$') OR (${table.captureStatus}='not_captured' AND ${table.recordDigest} IS NULL)`),
]);

export const interactionEvents = telemetrySchema.table('interaction_events', {
  eventId: uuid('event_id').primaryKey(),
  impressionEventId: uuid('impression_event_id'),
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
  check('interaction_events_impression_ref_check',sql`${table.impressionEventId} IS NULL OR(${table.eventType}<>'impression' AND ${table.serveId} IS NOT NULL AND ${table.position} IS NOT NULL)`),
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
  responsePayload: jsonb('response_payload').$type<Record<string, unknown>>(),
  modelOperationVersion: bigint('model_operation_version',{mode:'bigint'}),
  previousModelOperationVersion: bigint('previous_model_operation_version',{mode:'bigint'}),
  operationJson: text('operation_json'), sourceEnvelopeSha256: text('source_envelope_sha256'),
  logicalRequestSha256: text('logical_request_sha256'), withdrawalJson: text('withdrawal_json'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimToken: uuid('claim_token'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('ml_outbox_ready_idx').on(table.status, table.availableAt),
  index('ml_outbox_repository_index_lookup_idx').on(table.aggregateId, table.status, table.createdAt)
    .where(sql`${table.jobType}='repo_index'`),
]);

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
}, table => [index('generation_attempts_published_idx').on(table.userId, table.feedVersion)
  .where(sql`${table.status}='completed' AND ${table.mode} IN ('live','prewarm')`)]);

export const userGithubUnlinks = appSchema.table('user_github_unlinks', {
  userId: uuid('user_id').primaryKey().references(() => appUsers.userId, { onDelete: 'cascade' }),
  operationId: uuid('operation_id').notNull().unique(),
  githubId: text('github_id').notNull(),
  providerIdentityId: uuid('provider_identity_id'),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('user_github_unlinks_github_id_check', sql`${table.githubId} ~ '^[1-9][0-9]{0,18}$'`),
  check('user_github_unlinks_status_check', sql`${table.status} IN ('prepared','done','refused','superseded')`),
]);

// Private scoring data is deliberately excluded from ordinary product grants.
export const privateScoringSchema = pgSchema('private_scoring');
const scoringBytes = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
export const scoringGenerations = privateScoringSchema.table('scoring_generations', {
  generationId: uuid('generation_id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => appUsers.userId, { onDelete: 'cascade' }),
  feedVersion: bigint('feed_version', { mode: 'bigint' }).notNull(),
  contextBytes: scoringBytes('context_bytes').notNull(), contextDigest: text('context_digest').notNull(),
  scoredAt: timestamp('scored_at', { withTimezone: true, mode: 'string' }).notNull(),
  policyId: text('policy_id').notNull(), policyVersion: text('policy_version').notNull(),
  retentionDays: integer('retention_days').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`clock_timestamp()`),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  inputCount: smallint('input_count').notNull(),
}, table => [
  unique('scoring_generations_owner_key').on(table.generationId, table.userId),
  index('scoring_generations_expiry_idx').on(table.expiresAt, table.generationId),
  check('scoring_generations_feed_version_check', sql`${table.feedVersion}>0`),
  check('scoring_generations_context_bytes_check', sql`octet_length(${table.contextBytes}) BETWEEN 1 AND 16384`),
  check('scoring_generations_context_digest_check', sql`${table.contextDigest} ~ '^[a-f0-9]{64}$'`),
  check('scoring_generations_policy_id_check', sql`char_length(${table.policyId}) BETWEEN 1 AND 128`),
  check('scoring_generations_policy_version_check', sql`char_length(${table.policyVersion}) BETWEEN 1 AND 128`),
  check('scoring_generations_retention_days_check', sql`${table.retentionDays} BETWEEN 1 AND 365`),
  check('scoring_generations_input_count_check', sql`${table.inputCount} BETWEEN 1 AND 150`),
  check('scoring_generations_context_digest', sql`${table.contextDigest}=encode(sha256(${table.contextBytes}),'hex')`),
  check('scoring_generations_expiry', sql`${table.expiresAt}=${table.createdAt}+${table.retentionDays}*interval '24 hours'`),
]);
export const scoringInputs = privateScoringSchema.table('scoring_inputs', {
  generationId: uuid('generation_id').notNull(), userId: uuid('user_id').notNull(),
  repoId: uuid('repo_id').notNull().references(() => appRepos.repoId, { onDelete: 'cascade' }),
  providerPosition: smallint('provider_position').notNull(),
  snapshotBytes: scoringBytes('snapshot_bytes').notNull(), inputBytes: scoringBytes('input_bytes').notNull(),
  bindingDigest: text('binding_digest').notNull(), stageBytes: scoringBytes('stage_bytes').notNull(),
  recordDigest: text('record_digest').notNull(), rawHeavyScore: doublePrecision('raw_heavy_score').notNull(),
  finalScore: doublePrecision('final_score').notNull(), source: text('source').notNull(),
}, table => [
  primaryKey({ columns: [table.generationId, table.repoId] }),
  foreignKey({ name: 'scoring_inputs_owner_fkey', columns: [table.generationId, table.userId],
    foreignColumns: [scoringGenerations.generationId, scoringGenerations.userId] }).onDelete('cascade'),
  unique('scoring_inputs_position_key').on(table.generationId, table.providerPosition),
  unique('scoring_inputs_reference_key').on(table.generationId, table.userId, table.repoId, table.recordDigest),
  check('scoring_inputs_provider_position_check', sql`${table.providerPosition} BETWEEN 0 AND 149`),
  check('scoring_inputs_snapshot_bytes_check', sql`octet_length(${table.snapshotBytes}) BETWEEN 1 AND 4096`),
  check('scoring_inputs_binding_digest_check', sql`${table.bindingDigest} ~ '^[a-f0-9]{64}$'`),
  check('scoring_inputs_stage_bytes_check', sql`octet_length(${table.stageBytes}) BETWEEN 1 AND 8192`),
  check('scoring_inputs_record_digest_check', sql`${table.recordDigest} ~ '^[a-f0-9]{64}$'`),
  check('scoring_inputs_raw_heavy_score_check', sql`${table.rawHeavyScore}>'-Infinity'::double precision AND ${table.rawHeavyScore}<'Infinity'::double precision`),
  check('scoring_inputs_final_score_check', sql`${table.finalScore}>'-Infinity'::double precision AND ${table.finalScore}<'Infinity'::double precision`),
  check('scoring_inputs_source_check', sql`char_length(${table.source}) BETWEEN 1 AND 128`),
  check('scoring_inputs_input_bytes_check', sql`private_scoring.finite_input(${table.inputBytes})`),
]);
export const scoringGenerationWitnesses = privateScoringSchema.table('generation_witnesses', {
  witnessId: uuid('witness_id').defaultRandom().primaryKey(),
  generationId: uuid('generation_id').notNull().references(() => scoringGenerations.generationId, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`clock_timestamp()`),
}, table => [
  unique('generation_witnesses_generation_id_event_type_key').on(table.generationId, table.eventType),
  check('generation_witnesses_event_type_check', sql`${table.eventType} IN ('persisted','published','stale','revoked')`),
]);

export const feedIntentSessions = telemetrySchema.table('feed_intent_sessions', {
  sessionId: uuid('session_id').primaryKey(),
  userId: uuid('user_id').references(() => appUsers.userId,{onDelete:'set null'}),
  intentEpoch: bigint('intent_epoch',{mode:'bigint'}).notNull(),
  epochStartedMs: bigint('epoch_started_ms',{mode:'bigint'}).notNull(),
  policySha256: text('policy_sha256').notNull(), status: text('status').notNull(),
  beginOperationVersion: bigint('begin_operation_version',{mode:'bigint'}).notNull(),
  lastControlOperationVersion: bigint('last_control_operation_version',{mode:'bigint'}).notNull(),
  epochWitnessSha256: text('epoch_witness_sha256').notNull(), retirementWitnessSha256: text('retirement_witness_sha256'),
});
export const pendingModelFeedback = telemetrySchema.table('pending_model_feedback', {
  eventId: uuid('event_id').primaryKey().references(() => interactionEvents.eventId,{onDelete:'cascade'}),
  userId: uuid('user_id').notNull().references(() => appUsers.userId,{onDelete:'cascade'}),
  feedbackVersion: bigint('feedback_version',{mode:'bigint'}).notNull(),
  originalFeedbackJson: text('original_feedback_json').notNull(), acceptedAtMs: bigint('accepted_at_ms',{mode:'bigint'}).notNull(),
  canonicalAttribution: jsonb('canonical_attribution'), operationId: uuid('operation_id').references(() => mlOutbox.outboxId),
});

export const feedModelGenerations = telemetrySchema.table('feed_model_generations', {
  generationId: uuid('generation_id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => appUsers.userId,{onDelete:'cascade'}),
  sessionId: uuid('session_id').notNull().references(() => feedIntentSessions.sessionId),
  queueScope: text('queue_scope').notNull(), appliedContext: jsonb('applied_context').notNull(),
  validUntilMs: bigint('valid_until_ms',{mode:'bigint'}).notNull(),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},table=>[index('feed_model_generations_scope').on(table.userId,table.queueScope,table.validUntilMs)]);
