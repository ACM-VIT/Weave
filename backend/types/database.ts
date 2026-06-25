import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import {
  activities,
  users,
  follows,
  comments,
  repos,
  boards,
  boardRepos,
  boardsContainers,
  containerBoards,
  oauthCodes,
  refreshTokens,
} from '../db/schema.js';

// ─── Activity Table ─────────────────────────────────────────────────────────
export type ActivityRow = InferSelectModel<typeof activities>;
export type ActivityInsert = InferInsertModel<typeof activities>;
export type ActivityUpdate = Partial<ActivityInsert>;

// ─── Users Table ────────────────────────────────────────────────────────────
export type UserRow = InferSelectModel<typeof users>;
export type UserInsert = InferInsertModel<typeof users>;
export type UserUpdate = Partial<UserInsert>;

export type UserProfile = Pick<
  UserRow,
  | 'username'
  | 'full_name'
  | 'date_of_birth'
  | 'bio'
  | 'github_url'
  | 'github_handle'
  | 'avatar_url'
  | 'followers_count'
  | 'following_count'
  | 'saved_repos_count'
  | 'interests'
  | 'skills'
  | 'tech_stack'
  | 'onboarding_completed'
  | 'created_at'
>;

// ─── Follows Table ──────────────────────────────────────────────────────────
export type FollowRow = InferSelectModel<typeof follows>;
export type FollowInsert = InferInsertModel<typeof follows>;
export type FollowUpdate = Partial<FollowInsert>;

// ─── Comment Table ──────────────────────────────────────────────────────────
export type CommentRow = InferSelectModel<typeof comments>;
export type CommentInsert = InferInsertModel<typeof comments>;
export type CommentUpdate = Partial<CommentInsert>;

// ─── Repo Table ─────────────────────────────────────────────────────────────
export type RepoRow = InferSelectModel<typeof repos>;
export type RepoInsert = InferInsertModel<typeof repos>;
export type RepoUpdate = Partial<RepoInsert>;

// ─── Boards Table ───────────────────────────────────────────────────────────
export type BoardRow = InferSelectModel<typeof boards>;
export type BoardInsert = InferInsertModel<typeof boards>;
export type BoardUpdate = Partial<BoardInsert>;

// ─── Board Repos Table ──────────────────────────────────────────────────────
export type BoardRepoRow = InferSelectModel<typeof boardRepos>;
export type BoardRepoInsert = InferInsertModel<typeof boardRepos>;
export type BoardRepoUpdate = Partial<BoardRepoInsert>;

// ─── Boards Containers Table ────────────────────────────────────────────────
export type BoardsContainerRow = InferSelectModel<typeof boardsContainers>;
export type BoardsContainerInsert = InferInsertModel<typeof boardsContainers>;
export type BoardsContainerUpdate = Partial<BoardsContainerInsert>;

// ─── Container Boards Table ─────────────────────────────────────────────────
export type ContainerBoardRow = InferSelectModel<typeof containerBoards>;
export type ContainerBoardInsert = InferInsertModel<typeof containerBoards>;
export type ContainerBoardUpdate = Partial<ContainerBoardInsert>;

// ─── OAuth Codes Table ──────────────────────────────────────────────────────
export type OAuthCodeRow = InferSelectModel<typeof oauthCodes>;
export type OAuthCodeInsert = InferInsertModel<typeof oauthCodes>;
export type OAuthCodeUpdate = Partial<OAuthCodeInsert>;

// ─── Refresh Tokens Table ───────────────────────────────────────────────────
export type RefreshTokenRow = InferSelectModel<typeof refreshTokens>;
export type RefreshTokenInsert = InferInsertModel<typeof refreshTokens>;
export type RefreshTokenUpdate = Partial<RefreshTokenInsert>;
