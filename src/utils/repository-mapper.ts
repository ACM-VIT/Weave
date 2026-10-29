import { projectRepositoryLanguages } from '../../backend/services/repositoryLanguages';
import {parseOriginalFeedImpression} from '../services/feedImpressionAttribution';
import { recommendationSource } from '@/models/recommendation';
import { parseReadmeDigest } from '@/models/readme-digest';
import type { RepositoryApiPayload } from '@/api/repositories';
import type { RepositoryDetail, RepositoryStats, RepositoryStatus } from '@/models/repository';
import type { PinnedRepository } from '@/services/pinnedRepositoryCodec';
import {
  isCanonicalReadmeMediaUrl,
  isReadmeMediaVideoUrl,
  README_MEDIA_ALT_LIMIT,
  README_MEDIA_HASH_LIMIT,
  README_MEDIA_ITEM_LIMIT,
  README_MEDIA_MANIFEST_BYTE_LIMIT,
  README_MEDIA_SCHEMA_VERSION,
  README_MEDIA_URL_LIMIT,
  type ReadmeMediaImage,
  type ReadmeMediaManifest,
} from '../../backend/contracts/readmeMedia.v2';
import {
  normalizeOptionalRepositoryText,
  normalizeRepositoryCardSummary,
} from '@/utils/readme';

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    length += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return length;
}

function isManifestImage(value: unknown): value is ReadmeMediaImage {
  return hasExactKeys(value, ['alt', 'url'])
    && typeof value.alt === 'string' && value.alt.length <= README_MEDIA_ALT_LIMIT
    && typeof value.url === 'string' && value.url.length <= README_MEDIA_URL_LIMIT
    && isCanonicalReadmeMediaUrl(value.url);
}

function currentReadmeMediaManifest(
  value: unknown,
  contentVersion: number | null,
  contentHash: string | null,
  hasReadme: boolean | undefined,
): ReadmeMediaManifest | null {
  if (!Number.isSafeInteger(contentVersion) || contentVersion === null || contentVersion < 1
    || !contentHash || contentHash.length > README_MEDIA_HASH_LIMIT || typeof hasReadme !== 'boolean'
    || !hasExactKeys(value, ['schema_version', 'content_version', 'content_hash', 'readme_available', 'representation', 'poster', 'images', 'videos'])) {
    return null;
  }
  const manifest = value as Partial<ReadmeMediaManifest>;
  if (manifest.schema_version !== README_MEDIA_SCHEMA_VERSION || manifest.representation !== 'deferred'
    || manifest.content_version !== contentVersion || manifest.content_hash !== contentHash
    || manifest.readme_available !== hasReadme
    || !(manifest.poster === null || isManifestImage(manifest.poster))
    || !Array.isArray(manifest.images) || manifest.images.length > README_MEDIA_ITEM_LIMIT
    || !manifest.images.every(isManifestImage)
    || !Array.isArray(manifest.videos) || manifest.videos.length > README_MEDIA_ITEM_LIMIT
    || !manifest.videos.every(url => typeof url === 'string' && url.length <= README_MEDIA_URL_LIMIT
      && isReadmeMediaVideoUrl(url))) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string' || utf8ByteLength(serialized) > README_MEDIA_MANIFEST_BYTE_LIMIT) return null;
  } catch { return null; }
  return value as unknown as ReadmeMediaManifest;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableText(value: unknown): string | null {
  const normalized = text(value);
  return normalized || null;
}

function nullableScalarText(value: unknown): string | null {
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return nullableText(value);
}

function nullableCount(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function repositoryStatus(value: unknown): RepositoryStatus {
  return value === 'active' || value === 'archived' || value === 'deleted' || value === 'blocked'
    ? value
    : null;
}

function count(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      return text((item as { name?: unknown; slug?: unknown }).name)
        || text((item as { slug?: unknown }).slug);
    }).filter(Boolean))];
  }
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value).map((item) => item.trim()).filter(Boolean);
}

function listIds(payload: RepositoryApiPayload): string[] {
  const candidates = payload.selected_list_ids
    ?? payload.selected_collection_ids
    ?? payload.collection_ids;
  return stringArray(candidates).filter(id => !id.startsWith('legacy-board:'));
}

function splitFullName(value: string): { owner: string; name: string } | null {
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    owner: value.slice(0, separator).trim(),
    name: value.slice(separator + 1).trim(),
  };
}

function repositoryStats(payload: RepositoryApiPayload): RepositoryStats {
  const openIssues = count(payload.open_issues_count ?? payload.pr_count);
  return {
    stars: count(payload.star_count),
    forks: count(payload.fork_count ?? payload.forks_count),
    openIssues,
    likes: count(payload.likes_count),
    dislikes: count(payload.dislikes_count),
    saves: count(payload.saves_count),
    comments: count(payload.comments_count ?? payload.comment_count),
    views: count(payload.views_count),
  };
}

export function mapRepositoryDetail(
  payload: RepositoryApiPayload,
): RepositoryDetail | null {
  const id = text(payload.repo_id ?? payload.id);
  if (!id) return null;

  const rawFullName = text(payload.full_name ?? payload.github_repo);
  const parsedFullName = splitFullName(rawFullName);
  const owner = text(payload.owner) || parsedFullName?.owner || text(payload.owner_id);
  const name = text(payload.name ?? payload.repo_name) || parsedFullName?.name || '';
  if (!owner || !name) return null;

  const fullName = rawFullName || `${owner}/${name}`;
  const candidateUrl = text(payload.url ?? payload.github_repo_url ?? payload.html_url);
  const githubUrl = /^https:\/\/github\.com\//i.test(candidateUrl)
    ? candidateUrl
    : `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const composition = projectRepositoryLanguages({...payload,languages:payload.languages ?? payload.language_used});
  const languages = composition.languages;
  const selectedListIds = listIds(payload);
  const viewerReaction = payload.viewer_reaction === 'like'
    || payload.viewer_reaction === 'dislike'
    ? payload.viewer_reaction
    : null;
  const updatedAt = nullableText(payload.updated_at);
  const readmeFull = typeof payload.readme_md === 'string' ? payload.readme_md
    : typeof payload.readme === 'string' ? payload.readme : null;
  const hasReadme = typeof payload.readme_available === 'boolean' ? payload.readme_available
    : readmeFull ? true : undefined;
  const contentVersion = nullableCount(payload.content_version);
  const readmeDigest = parseReadmeDigest(payload.readme_digest);
  // Legacy detail responses return an inline body plus its current digest, but
  // omit the standalone hash. Only a digest for this exact body version can
  // supply that identity; unversioned feeds and stale digests cannot.
  const contentHash = nullableText(payload.content_hash)
    ?? (readmeFull && contentVersion !== null && readmeDigest?.content_version === contentVersion
      ? readmeDigest.content_hash : null);
  const readmeSourcePath = nullableText(payload.readme_source_path);
  const readmeDefaultBranch = nullableText(payload.readme_default_branch);
  const readmeBaseUrl = nullableText(payload.readme_base_url);
  const readmeMediaManifest = currentReadmeMediaManifest(
    payload.readme_media_manifest, contentVersion, contentHash, hasReadme,
  );
  const summarySource = payload.summary_source === 'generated'
    || payload.summary_source === 'description_fallback'
    ? payload.summary_source
    : null;

  return {
    id,
    githubId: nullableScalarText(payload.github_id),
    fullName,
    name,
    owner,
    githubUrl,
    status: repositoryStatus(payload.status),
    description: normalizeOptionalRepositoryText(payload.description) ?? '',
    readmeDigest,
    summaryId: nullableText(payload.summary_id),
    readmeSummary: normalizeRepositoryCardSummary(
      normalizeOptionalRepositoryText(payload.summary)
        ?? normalizeOptionalRepositoryText(payload.readme_summary),
      readmeFull,
    ),
    readmeFull,
    readmeMediaManifest,
    hasReadme,
    contentHash,
    readmeSourcePath,
    readmeDefaultBranch,
    readmeBaseUrl,
    summaryHighlights: stringArray(payload.summary_highlights),
    summaryPromptVersion: nullableText(payload.summary_prompt_version),
    summaryFormatVersion: nullableText(payload.summary_format_version),
    summarySource,
    languages,
    languageBreakdown: composition.language_breakdown ?? null,
    languageTotalSize: composition.language_total_size ?? null,
    languageBreakdownComplete: composition.language_breakdown_complete ?? null,
    languageObservedAt: composition.language_observed_at ?? null,
    topics: stringArray(payload.topics),
    primaryLanguage: Object.hasOwn(payload,'primary_language') ? nullableText(payload.primary_language) : languages[0] ?? null,
    stats: repositoryStats(payload),
    createdAt: nullableText(payload.repository_created_at ?? payload.created_at),
    updatedAt,
    observedAt: nullableText(payload.stats_observed_at ?? payload.observed_at),
    contentUpdatedAt: nullableText(payload.content_updated_at),
    sourceUpdatedAt: nullableText(payload.source_updated_at),
    contentVersion,
    summaryModelVersion: nullableText(payload.summary_model_version ?? payload.model_version),
    viewerReaction,
    viewerSaved: payload.viewer_saved === true || payload.saved === true,
    selectedListIds,
    ownerGithubId: nullableScalarText(payload.owner_github_id),
    ownerUserId: nullableText(payload.owner_user_id),
    ownerUsername: nullableText(payload.owner_username),
    ownerDisplayName: nullableText(payload.owner_display_name),
    ownerAvatarUrl: nullableText(payload.owner_avatar_url),
    ownerBio: normalizeOptionalRepositoryText(payload.owner_bio)
      ?? normalizeOptionalRepositoryText(payload.owner_profile?.bio),
    ownerProfileId: nullableText(payload.owner_profile_id),
    ownerProfileKind: nullableText(payload.owner_profile_kind),
    ownerProfileClaimedUserId: nullableText(payload.owner_profile_claimed_user_id),
    viewerFollowsOwner: typeof payload.viewer_follows_owner === 'boolean'
      ? payload.viewer_follows_owner
      : null,
    ...(payload.recommendation_source !== undefined
      ? { recommendationSource: recommendationSource(payload.recommendation_source) } : {}),
    serveId: nullableText(payload.serve_id),
    feedSessionId:nullableText(payload.feed_session_id),
    originalImpression:parseOriginalFeedImpression(payload.client_original_impression),
    feedPosition: Number.isInteger(payload.position) ? Number(payload.position) : null,
  };
}

export function mapRepositoryList(payloads: RepositoryApiPayload[]): RepositoryDetail[] {
  return payloads
    .map(mapRepositoryDetail)
    .filter((repository): repository is RepositoryDetail => repository !== null);
}

export function mapPinnedRepository(repository: PinnedRepository): RepositoryDetail | null {
  return mapRepositoryDetail({
    repo_id: repository.repositoryId,
    full_name: `${repository.owner}/${repository.name}`,
    owner: repository.owner,
    name: repository.name,
    url: repository.url,
    description: repository.description,
    primary_language: repository.primaryLanguage,
    languages: repository.primaryLanguage ? [repository.primaryLanguage] : [],
  });
}
