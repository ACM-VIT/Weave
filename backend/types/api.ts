import type { Response } from 'express';

export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiErrorResponse {
  success: false;
  error: string;
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface FollowBody {
  follower_id: string;
}

export interface RepoImportBody {
  github_repo_url: string;
  owner_id: string;
}

export interface PostgresError {
  code: string;
  message: string;
  details?: string;
  hint?: string;
}

export interface DatabaseErrorOptions {
  notFoundMessage?: string;
  conflictMessage?: string;
  missingRequiredMessage?: string;
  invalidReferenceMessage?: string;
  invalidFormatMessage?: string;
}
