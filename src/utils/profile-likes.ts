import type { FeedbackAction } from '@/constants/feedbackActions';
import type { RepositoryDetail } from '@/models/repository';

export type ProfileLikeOverride = {
  liked: boolean;
  repository: RepositoryDetail;
};

export type ProfileLikeOverrides = Record<string, ProfileLikeOverride>;

export function profileLikeOverridesQueryKey(userId: string | null | undefined) {
  return ['profile-like-overrides', userId ?? null] as const;
}

export function optimisticLikeDelta(
  currentlyLiked: boolean,
  action: FeedbackAction,
): -1 | 0 | 1 {
  if (action === 'like' && !currentlyLiked) return 1;
  if ((action === 'unlike' || action === 'dislike') && currentlyLiked) return -1;
  return 0;
}

export function isRepositoryOptimisticallyLiked(
  overrides: ProfileLikeOverrides | undefined,
  repository: RepositoryDetail,
): boolean {
  return overrides?.[repository.id]?.liked ?? repository.viewerReaction === 'like';
}

export function patchProfileLikeOverrides(
  current: ProfileLikeOverrides | undefined,
  repository: RepositoryDetail,
  action: FeedbackAction,
): ProfileLikeOverrides | undefined {
  if (!['like', 'unlike', 'dislike'].includes(action)) return current;

  const liked = action === 'like';
  const delta = optimisticLikeDelta(
    isRepositoryOptimisticallyLiked(current, repository),
    action,
  );
  const optimisticRepository: RepositoryDetail = {
    ...repository,
    viewerReaction: liked ? 'like' : action === 'dislike' ? 'dislike' : null,
    stats: {
      ...repository.stats,
      likes: Math.max(0, repository.stats.likes + delta),
    },
  };

  return {
    ...current,
    [repository.id]: { liked, repository: optimisticRepository },
  };
}

export function applyProfileLikeOverrides(
  repositories: readonly RepositoryDetail[],
  overrides: ProfileLikeOverrides | undefined,
): RepositoryDetail[] {
  if (!overrides || Object.keys(overrides).length === 0) return [...repositories];

  const merged = new Map(repositories.map((repository) => [repository.id, repository]));
  const optimisticLikes: RepositoryDetail[] = [];

  for (const override of Object.values(overrides)) {
    if (!override.liked) {
      merged.delete(override.repository.id);
      continue;
    }

    merged.delete(override.repository.id);
    optimisticLikes.push(override.repository);
  }

  return [...optimisticLikes, ...merged.values()];
}
