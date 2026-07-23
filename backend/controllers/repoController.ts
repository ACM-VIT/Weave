import type { Request, Response } from "express";
import * as githubService from "../services/githubService.js";
import * as repoService from "../services/repoService.js";
import * as summaryService from "../services/summaryService.js";
import {
  sendControllerError,
  sendError,
  sendSuccess,
  sendDatabaseError,
} from "../utils/response.js";
import { isValidUuid, parsePaginationParams } from "../utils/validators.js";

import type { PostgresError, RepoInsert, DatabaseErrorOptions } from "../types/index.js";

function sendRepoDatabaseError(res: Response, error: PostgresError): void {
  return sendDatabaseError(res, error, {
    notFoundMessage: "Repository not found.",
    conflictMessage: "Repository already exists.",
    missingRequiredMessage: "Repository data is missing required fields.",
    invalidReferenceMessage: "Repository data references an invalid record.",
  } satisfies DatabaseErrorOptions);
}

interface RepoBodyInput {
  github_repo_url: string;
  owner_id: string;
}

async function buildRepoPayload(body: RepoBodyInput): Promise<RepoInsert> {
  const { github_repo_url: githubRepoUrl, owner_id: ownerId } = body;
  const parsedRepo = githubService.parseGitHubRepoUrl(githubRepoUrl);

  if (!parsedRepo) {
    throw new Error("github_repo_url must be a valid GitHub repository URL.");
  }

  const githubRepo = await githubService.fetchRepoMetadataFromGitHub(
    parsedRepo.owner,
    parsedRepo.repo,
  );

  return {
    github_repo_url: githubRepo.github_repo_url,
    owner_id: ownerId,
    repo_name: githubRepo.repo_name,
    full_name: githubRepo.full_name,
    description: githubRepo.description,
    language_used: githubRepo.language_breakdown || [],
    topics: githubRepo.topics || [],
    readme_summary: summaryService.summarizeReadme(githubRepo.readme),
    star_count: githubRepo.stars_count || 0,
    forks_count: githubRepo.forks_count || 0,
    pr_count: githubRepo.pr_count || 0,
  };
}

export async function getAllRepos(req: Request, res: Response): Promise<void> {
  const pagination = parsePaginationParams(
    req.query as { limit?: string; offset?: string },
  );

  if (!pagination) {
    return sendError(
      res,
      400,
      "limit must be positive and offset must be zero or greater.",
    );
  }

  const { data, error } = await repoService.getAllRepos(pagination);

  if (error) {
    return sendRepoDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

export async function getTrendingRepos(req: Request, res: Response): Promise<void> {
  let limit = 10;
  if (req.query.limit) {
    const parsedLimit = parseInt(req.query.limit as string, 10);
    if (!isNaN(parsedLimit) && parsedLimit > 0) {
      // Enforce a maximum limit of 30 to prevent unbounded DB/Redis pressure attacks
      limit = Math.min(parsedLimit, 30);
    }
  }

  const { data, error } = await repoService.getTrendingRepos(limit);

  if (error) {
    return sendRepoDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

export async function getRepoById(req: Request, res: Response): Promise<void> {
  const repoId = req.params.repoId as string;

  if (!isValidUuid(repoId)) {
    return sendError(res, 400, "repoId must be a valid UUID.");
  }

  const { data, error } = await repoService.getRepoById(repoId);

  if (error) {
    return sendRepoDatabaseError(res, error);
  }

  return sendSuccess(res, 200, data);
}

export async function importRepo(req: Request, res: Response): Promise<void> {
  const { github_repo_url: githubRepoUrl, owner_id: ownerId } =
    req.body as Partial<RepoBodyInput>;

  if (!githubRepoUrl || !ownerId) {
    return sendError(res, 400, "github_repo_url and owner_id are required.");
  }

  try {
    const repoPayload = await buildRepoPayload(req.body as RepoBodyInput);
    const { data, error } = await repoService.createRepo(repoPayload);

    if (error) {
      return sendRepoDatabaseError(res, error);
    }

    return sendSuccess(res, 201, data);
  } catch (err) {
    return sendControllerError(res, err as Error);
  }
}

export async function viewRepo(req: Request, res: Response): Promise<void> {
  const repoId = req.params.repoId as string;

  if (!isValidUuid(repoId)) {
    return sendError(res, 400, "repoId must be a valid UUID.");
  }

  const { data, error } = await repoService.incrementRepoViews(repoId);

  if (error) {
    return sendRepoDatabaseError(res, error);
  }

  if (data === false) {
    return sendError(res, 404, "Repository not found.");
  }

  return sendSuccess(res, 200, { message: "View counted." });
}

export async function syncRepo(req: Request, res: Response): Promise<void> {
  const repoId = req.params.repoId as string;
  const { github_repo_url: githubRepoUrl, owner_id: ownerId } =
    req.body as Partial<RepoBodyInput>;

  if (!isValidUuid(repoId)) {
    return sendError(res, 400, "repoId must be a valid UUID.");
  }

  if (!githubRepoUrl || !ownerId) {
    return sendError(res, 400, "github_repo_url and owner_id are required.");
  }

  try {
    const repoPayload = await buildRepoPayload(req.body as RepoBodyInput);
    const { data, error } = await repoService.updateRepoById(
      repoId,
      repoPayload,
    );

    if (error) {
      return sendRepoDatabaseError(res, error);
    }

    return sendSuccess(res, 200, data);
  } catch (err) {
    return sendControllerError(res, err as Error);
  }
}
