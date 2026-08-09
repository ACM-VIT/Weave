import type { FeedbackAction } from '@/api/activity';
import type { FeedPage, FeedRepositoryPayload } from '@/api/feed';
import type { RepositoryData } from '@/data/repositories';
import { normalizeOptionalRepositoryText } from '@/utils/readme';

export type FeedRepositoryTarget = {
  repoId: string;
  serveId?: string | null;
  position?: number | null;
};

type FeedCache = {
  pages: FeedPage[];
  pageParams: unknown[];
};

function countText(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string'
    ? String(value)
    : '0';
}

function normalizedTechnologyNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((language) => {
      if (typeof language === 'string') return language.trim();
      if (!language || typeof language !== 'object') return '';
      const name = (language as { name?: unknown }).name;
      return typeof name === 'string' ? name.trim() : '';
    })
    .filter(Boolean);
}

export function mapFeedRepository(
  backendItem: FeedRepositoryPayload,
): RepositoryData | null {
  const repoId = typeof backendItem.repo_id === 'string' ? backendItem.repo_id : '';
  const repoFullName = typeof backendItem.full_name === 'string' && backendItem.full_name
    ? backendItem.full_name
    : typeof backendItem.github_repo === 'string'
      ? backendItem.github_repo
      : '';
  const separator = repoFullName.indexOf('/');
  if (!repoId || separator <= 0 || separator === repoFullName.length - 1) return null;

  const owner = repoFullName.slice(0, separator);
  const title = repoFullName.slice(separator + 1);
  const canonicalGithubUrl = `https://github.com/${owner}/${title}`;
  const backendUrl = typeof backendItem.url === 'string'
    ? backendItem.url
    : typeof backendItem.html_url === 'string'
      ? backendItem.html_url
      : '';
  const rawLanguages = Array.isArray(backendItem.languages)
    ? backendItem.languages
    : backendItem.language_used;
  const legacyLanguageMap = !Array.isArray(rawLanguages)
    && rawLanguages
    && typeof rawLanguages === 'object'
    ? Object.keys(rawLanguages)
    : [];
  const technologyNames = normalizedTechnologyNames(rawLanguages);
  const description = normalizeOptionalRepositoryText(backendItem.description) ?? '';
  const activeReadmeSummary = normalizeOptionalRepositoryText(backendItem.summary)
    ?? normalizeOptionalRepositoryText(backendItem.readme_summary);
  const fullReadme = normalizeOptionalRepositoryText(backendItem.readme_md)
    ?? normalizeOptionalRepositoryText(backendItem.readme);
  const updatedAt = typeof backendItem.updated_at === 'string'
    ? new Date(backendItem.updated_at)
    : null;

  return {
    id: repoId,
    serveId: typeof backendItem.serve_id === 'string' ? backendItem.serve_id : null,
    feedPosition: Number.isInteger(backendItem.position) ? backendItem.position : null,
    viewerReaction: backendItem.viewer_reaction === 'like'
      || backendItem.viewer_reaction === 'dislike'
      ? backendItem.viewer_reaction
      : null,
    viewerSaved: backendItem.viewer_saved === true,
    title,
    owner,
    githubUrl: backendUrl.startsWith('https://github.com/')
      ? backendUrl
      : canonicalGithubUrl,
    ownerUserId: typeof backendItem.owner_user_id === 'string'
      ? backendItem.owner_user_id
      : null,
    ownerBio: normalizeOptionalRepositoryText(backendItem.owner_bio)
      ?? normalizeOptionalRepositoryText(backendItem.owner_profile?.bio),
    ownerProfileId: typeof backendItem.owner_profile_id === 'string'
      ? backendItem.owner_profile_id
      : null,
    ownerProfileClaimedUserId: typeof backendItem.owner_profile_claimed_user_id === 'string'
      ? backendItem.owner_profile_claimed_user_id
      : null,
    viewerFollowsOwner: typeof backendItem.viewer_follows_owner === 'boolean'
      ? backendItem.viewer_follows_owner
      : null,
    description,
    readmeSummary: activeReadmeSummary,
    readmeFull: fullReadme,
    stats: {
      stars: countText(backendItem.star_count),
      views: countText(backendItem.views_count),
      bugs: countText(backendItem.open_issues_count ?? backendItem.pr_count),
      forks: countText(backendItem.fork_count),
      likes: countText(backendItem.likes_count ?? backendItem.saves_count),
      comments: countText(backendItem.comments_count ?? backendItem.comment_count),
    },
    updatedText: updatedAt && Number.isFinite(updatedAt.getTime())
      ? `updated ${updatedAt.toLocaleDateString()}`
      : 'updated recently',
    techStack: technologyNames.length > 0
      ? technologyNames
      : legacyLanguageMap,
  };
}

export function getFeedItemIdentity(
  repository: RepositoryData,
  fallbackPosition: number,
): string {
  const serveIdentity = repository.serveId ?? 'unserved';
  const positionIdentity = repository.feedPosition ?? fallbackPosition;
  return `${serveIdentity}:${repository.id}:${positionIdentity}`;
}

function matchesTarget(
  repository: FeedRepositoryPayload,
  target: FeedRepositoryTarget,
): boolean {
  if (repository.repo_id !== target.repoId) return false;
  if (target.serveId && repository.serve_id !== target.serveId) return false;
  if (target.position !== null && target.position !== undefined
    && repository.position !== target.position) return false;
  return true;
}

function reactionAfter(
  action: FeedbackAction,
  currentReaction: FeedRepositoryPayload['viewer_reaction'],
): 'like' | 'dislike' | null | undefined {
  if (action === 'like') return 'like';
  if (action === 'dislike') return 'dislike';
  if (action === 'unlike') return currentReaction === 'like' ? null : currentReaction;
  if (action === 'undislike') return currentReaction === 'dislike' ? null : currentReaction;
  return undefined;
}

export function patchFeedReaction<T extends FeedCache>(
  cachedFeed: T | undefined,
  target: FeedRepositoryTarget,
  action: FeedbackAction,
): T | undefined {
  if (!cachedFeed) return cachedFeed;

  let feedChanged = false;
  const pages = cachedFeed.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.map((repository) => {
      if (!matchesTarget(repository, target)) return repository;
      const previousReaction = repository.viewer_reaction;
      const nextReaction = reactionAfter(action, previousReaction);
      if (nextReaction === undefined) return repository;
      if (previousReaction === nextReaction) return repository;

      const previousLikes = Number(repository.likes_count) || 0;
      const likeDelta = Number(nextReaction === 'like') - Number(previousReaction === 'like');
      pageChanged = true;
      return {
        ...repository,
        viewer_reaction: nextReaction,
        likes_count: Math.max(0, previousLikes + likeDelta),
      };
    });

    if (!pageChanged) return page;
    feedChanged = true;
    return { ...page, items };
  });

  return feedChanged ? { ...cachedFeed, pages } : cachedFeed;
}

export function patchFeedSaved<T extends FeedCache>(
  cachedFeed: T | undefined,
  target: FeedRepositoryTarget,
  saved: boolean,
): T | undefined {
  if (!cachedFeed) return cachedFeed;

  let feedChanged = false;
  const pages = cachedFeed.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.map((repository) => {
      if (!matchesTarget(repository, target) || repository.viewer_saved === saved) {
        return repository;
      }
      pageChanged = true;
      return { ...repository, viewer_saved: saved };
    });

    if (!pageChanged) return page;
    feedChanged = true;
    return { ...page, items };
  });

  return feedChanged ? { ...cachedFeed, pages } : cachedFeed;
}
