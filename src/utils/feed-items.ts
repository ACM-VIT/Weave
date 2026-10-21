import type { RepositoryData } from '../data/repositories';

// Helper to map backend ML JSON to the frontend RepositoryData format
export function mapBackendToFrontend(backendItem: any): RepositoryData | null {
  const repoId = typeof backendItem.repo_id === 'string' ? backendItem.repo_id : '';
  const repoFullName = typeof backendItem.full_name === 'string'
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
  const rawLanguages = backendItem.languages ?? backendItem.language_used ?? [];
  const techStack = Array.isArray(rawLanguages)
    ? rawLanguages.map((language) =>
        typeof language === 'string' ? language : language?.name
      ).filter(Boolean)
    : Object.keys(rawLanguages || {});

  return {
    id: repoId,
    serveId: backendItem.serve_id ?? null,
    feedPosition: backendItem.position ?? null,
    viewerReaction: backendItem.viewer_reaction === 'like' || backendItem.viewer_reaction === 'dislike'
      ? backendItem.viewer_reaction : null,
    viewerSaved: backendItem.viewer_saved === true,
    title,
    owner,
    githubUrl: backendUrl.startsWith('https://github.com/') ? backendUrl : canonicalGithubUrl,
    ownerUserId: typeof backendItem.owner_user_id === 'string'
      ? backendItem.owner_user_id
      : null,
    ownerBio: typeof backendItem.owner_bio === 'string'
      ? backendItem.owner_bio
      : typeof backendItem.owner_profile?.bio === 'string'
        ? backendItem.owner_profile.bio
        : null,
    ownerProfileId: typeof backendItem.owner_profile_id === 'string'
      ? backendItem.owner_profile_id
      : null,
    ownerProfileClaimedUserId: typeof backendItem.owner_profile_claimed_user_id === 'string'
      ? backendItem.owner_profile_claimed_user_id
      : null,
    viewerFollowsOwner: typeof backendItem.viewer_follows_owner === 'boolean'
      ? backendItem.viewer_follows_owner
      : null,
    description: backendItem.description || '',
    readmeSummary: backendItem.readme_summary || backendItem.summary || 'No summary available.',
    readmeFull: backendItem.readme_md || backendItem.readme || 'No readme available.',
    stats: {
      stars: (backendItem.star_count ?? 0).toString(),
      views: (backendItem.views_count ?? 0).toString(),
      bugs: (backendItem.open_issues_count ?? backendItem.pr_count ?? 0).toString(),
      forks: (backendItem.fork_count ?? 0).toString(),
      likes: (backendItem.likes_count ?? backendItem.saves_count ?? 0).toString(),
      comments: (backendItem.comments_count ?? backendItem.comment_count ?? 0).toString(),
    },
    updatedText: backendItem.updated_at
      ? `updated ${new Date(backendItem.updated_at).toLocaleDateString()}`
      : 'updated recently',
    techStack,
  };
}

export type FeedItem = { feedId: string; repository: RepositoryData };
export type FeedPage = { items: readonly Record<string, any>[] };

// React Query pages/items are immutable and structurally shared. Weak caches do
// not retain discarded query histories or share viewer projections across users.
export function createFeedItemMapper(mapRepository = mapBackendToFrontend) {
  const repositories = new WeakMap<object, RepositoryData | null>();
  const pages = new WeakMap<FeedPage['items'], readonly RepositoryData[]>();
  let previous: FeedItem[] = [];

  return (sourcePages: readonly FeedPage[] | undefined): FeedItem[] => {
    const next: FeedItem[] = [];
    for (const page of sourcePages ?? []) {
      let mappedPage = pages.get(page.items);
      if (!mappedPage) {
        const mapped: RepositoryData[] = [];
        for (const source of page.items) {
          let repository = repositories.get(source);
          if (repository === undefined) {
            repository = mapRepository(source);
            repositories.set(source, repository);
          }
          if (repository) mapped.push(repository);
        }
        mappedPage = mapped;
        pages.set(page.items, mappedPage);
      }
      for (const repository of mappedPage) {
        const index = next.length;
        const retained = previous[index];
        next.push(retained?.repository === repository ? retained : {
          feedId: `${repository.id}-${index}-${repository.viewerReaction ?? 'none'}-${repository.viewerSaved ? 'saved' : 'unsaved'}`,
          repository,
        });
      }
    }
    if (previous.length !== next.length || next.some((entry, index) => entry !== previous[index])) {
      previous = next;
    }
    return previous;
  };
}
