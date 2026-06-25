import { pgTable, uuid, varchar, text, date, integer, jsonb, boolean, timestamp, primaryKey, unique, interval, check, AnyPgColumn, index } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// 1. USERS
export const users = pgTable('users', {
  user_id: uuid('user_id').primaryKey().notNull(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  full_name: varchar('full_name', { length: 100 }),
  date_of_birth: date('date_of_birth', { mode: 'string' }),
  bio: text('bio'),
  github_url: varchar('github_url', { length: 512 }),
  github_id: varchar('github_id', { length: 100 }).unique(),
  github_handle: varchar('github_handle', { length: 100 }),
  avatar_url: varchar('avatar_url', { length: 512 }),
  followers_count: integer('followers_count').default(0),
  following_count: integer('following_count').default(0),
  saved_repos_count: integer('saved_repos_count').default(0),
  interests: jsonb('interests').default('[]').notNull(),
  skills: jsonb('skills').default('[]').notNull(),
  tech_stack: jsonb('tech_stack').default('[]').notNull(),
  onboarding_completed: boolean('onboarding_completed').default(false).notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
});

// 2. FOLLOWS
export const follows = pgTable('follows', {
  follower_id: uuid('follower_id').references(() => users.user_id, { onDelete: 'cascade' }).notNull(),
  following_id: uuid('following_id').references(() => users.user_id, { onDelete: 'cascade' }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.follower_id, t.following_id] }),
  noSelfFollow: check('no_self_follow', sql`${t.follower_id} <> ${t.following_id}`),
  followerIdx: index('follows_follower_id_idx').on(t.follower_id),
  followingIdx: index('follows_following_id_idx').on(t.following_id),
}));

// 3. REFRESH TOKENS
export const refreshTokens = pgTable('refresh_tokens', {
  token_id: uuid('token_id').defaultRandom().primaryKey(),
  user_id: uuid('user_id').references(() => users.user_id, { onDelete: 'cascade' }).notNull(),
  refresh_token_hash: text('refresh_token_hash').notNull().unique(),
  expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  is_revoked: boolean('is_revoked').default(false),
  last_used_at: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
});

// 4. OAUTH CODES
export const oauthCodes = pgTable('oauth_codes', {
  code: uuid('code').defaultRandom().primaryKey(),
  user_id: uuid('user_id').references(() => users.user_id, { onDelete: 'cascade' }).notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
});

// 5. REPOS
export const repos = pgTable('repo', {
  repo_id: uuid('repo_id').defaultRandom().primaryKey(),
  github_repo_url: varchar('github_repo_url', { length: 200 }).notNull().unique(),
  owner_id: varchar('owner_id', { length: 100 }).notNull(),
  repo_name: varchar('repo_name', { length: 200 }).notNull(),
  full_name: varchar('full_name', { length: 255 }).notNull(),
  description: text('description'),
  language_used: jsonb('language_used').default('[]'),
  topics: jsonb('topics').default('[]'),
  readme_summary: text('readme_summary'),
  likes_count: integer('likes_count').default(0),
  comments_count: integer('comments_count').default(0),
  saves_count: integer('saves_count').default(0),
  views_count: integer('views_count').default(0),
  forks_count: integer('forks_count').default(0),
  pr_count: integer('pr_count').default(0),
  created_at: timestamp('created_at', { mode: 'string' }).defaultNow(),
  updated_at: timestamp('updated_at', { mode: 'string' }).defaultNow(),
}, (t) => ({
  ownerIdx: index('repos_owner_id_idx').on(t.owner_id),
}));

// 6. ACTIVITY
export const activities = pgTable('activity', {
  activity_id: uuid('activity_id').defaultRandom().primaryKey(),
  user_id: uuid('user_id').references(() => users.user_id, { onDelete: 'cascade' }).notNull(),
  repo_id: uuid('repo_id').references(() => repos.repo_id, { onDelete: 'cascade' }).notNull(),
  time_spent: interval('time_spent'),
  likelihood_count: integer('likelihood_count').default(0),
  is_saved: boolean('is_saved').default(false),
}, (t) => ({
  unq: unique('activity_user_repo_unique').on(t.user_id, t.repo_id),
  repoIdx: index('activity_repo_id_idx').on(t.repo_id),
}));

// 7. COMMENT
export const comments = pgTable('comment', {
  comment_id: uuid('comment_id').defaultRandom().primaryKey(),
  user_id: uuid('user_id').references(() => users.user_id, { onDelete: 'cascade' }).notNull(),
  repo_id: uuid('repo_id').references(() => repos.repo_id, { onDelete: 'cascade' }).notNull(),
  parent_comment_id: uuid('parent_comment_id').references((): AnyPgColumn => comments.comment_id, { onDelete: 'cascade' }),
  comment: text('comment').notNull(),
  created_at: timestamp('created_at', { mode: 'string' }).defaultNow(),
}, (t) => ({
  repoIdx: index('comment_repo_id_idx').on(t.repo_id),
  userIdx: index('comment_user_id_idx').on(t.user_id),
  parentCommentIdx: index('comment_parent_comment_id_idx').on(t.parent_comment_id),
}));

// 8. BOARDS
export const boards = pgTable('boards', {
  board_id: uuid('board_id').defaultRandom().primaryKey(),
  user_id: uuid('user_id').references(() => users.user_id, { onDelete: 'cascade' }).notNull(),
  board_name: varchar('board_name', { length: 100 }).notNull(),
  visibility: varchar('visibility', { length: 20 }).default('public').notNull(),
  description: text('description'),
  repos_count: integer('repos_count').default(0),
  created_at: timestamp('created_at', { mode: 'string' }).defaultNow(),
}, (t) => ({
  visibilityCheck: check('visibility_check', sql`${t.visibility} IN ('public', 'private')`),
  userIdx: index('boards_user_id_idx').on(t.user_id),
}));

// 9. BOARD REPOS
export const boardRepos = pgTable('board_repos', {
  board_id: uuid('board_id').references(() => boards.board_id, { onDelete: 'cascade' }).notNull(),
  repo_id: uuid('repo_id').references(() => repos.repo_id, { onDelete: 'cascade' }).notNull(),
  added_at: timestamp('added_at', { mode: 'string' }).defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.board_id, t.repo_id] }),
  repoIdx: index('board_repos_repo_id_idx').on(t.repo_id),
}));

// 10. BOARDS CONTAINERS
export const boardsContainers = pgTable('boards_containers', {
  container_id: uuid('container_id').defaultRandom().primaryKey(),
  user_id: uuid('user_id').references(() => users.user_id, { onDelete: 'cascade' }).notNull(),
  container_name: varchar('container_name', { length: 100 }).default('boards_container').notNull(),
  description: text('description'),
  created_at: timestamp('created_at', { mode: 'string' }).defaultNow(),
}, (t) => ({
  userIdx: index('boards_containers_user_id_idx').on(t.user_id),
}));

// 11. CONTAINER BOARDS
export const containerBoards = pgTable('container_boards', {
  container_id: uuid('container_id').references(() => boardsContainers.container_id, { onDelete: 'cascade' }).notNull(),
  board_id: uuid('board_id').references(() => boards.board_id, { onDelete: 'cascade' }).notNull(),
  added_at: timestamp('added_at', { mode: 'string' }).defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.container_id, t.board_id] }),
  boardIdx: index('container_boards_board_id_idx').on(t.board_id),
}));
