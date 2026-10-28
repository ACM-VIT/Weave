import { useMemo } from 'react';
import { useRepositoryReadme } from '@/hooks/use-repository-readme';
import type { RepositoryData } from '@/data/repositories';
import { ReadmePopup } from './ReadmePopup';

/** Mounted only when the viewer opens the original README from a feed row. */
export function FeedReadmePopup({ repository, onClose, summaryText, summaryVersion, summaryHash }: {
  repository: RepositoryData;
  onClose: () => void;
  summaryText?: string | null;
  summaryVersion?: number | null;
  summaryHash?: string | null;
}) {
  const manifest = repository.readmeMediaManifest;
  const expectedVersion = summaryVersion ?? repository.contentVersion;
  const expectedHash = summaryHash ?? repository.contentHash;
  const manifestMatchesSummary = summaryText !== undefined && Boolean(manifest
    && manifest.schema_version === 2 && manifest.representation === 'deferred'
    && manifest.content_version === expectedVersion && manifest.content_hash === expectedHash
    && manifest.content_version === repository.contentVersion && manifest.content_hash === repository.contentHash
    && manifest.readme_available === repository.hasReadme);
  // Older feeds include canonical bytes but omit their content identity. Verify
  // the current detail instead of pairing an unversioned body with a newer digest.
  const mediaRepository = useMemo(() => summaryText !== undefined
    && (!repository.contentVersion || !repository.contentHash)
    ? {...repository,readmeFull:null} : repository, [repository,summaryText]);
  const query = useRepositoryReadme(mediaRepository, summaryText === undefined || !manifestMatchesSummary);
  const source = query.data ?? (query.terminalError ? {...repository,readmeFull:null} : repository);
  const matchingMedia = summaryText === undefined || source.contentVersion === expectedVersion
    && (!expectedHash || source.contentHash === expectedHash);
  const media = matchingMedia ? source.readmeFull : null;
  const manifestMedia = manifestMatchesSummary ? manifest : null;
  const manifestImages = useMemo(() => manifestMedia
    ? [...new Map([...(manifestMedia.poster ? [manifestMedia.poster] : []), ...manifestMedia.images]
      .map(image => [image.url, image])).values()].slice(0, 3)
    : undefined, [manifestMedia]);
  return <ReadmePopup isVisible onClose={onClose} title={repository.name} contentKind={summaryText === undefined ? "readme" : "summary"}
    readmeText={summaryText === undefined ? source.readmeFull : summaryText} mediaMarkdown={media}
    mediaImages={manifestImages} mediaVideos={manifestMedia?.videos}
    mediaMessage={summaryText !== undefined && !media && !manifestMedia
      ? query.isFetching || query.isPending ? 'Loading images and videos…' : query.isError ? 'Could not load README images and videos.'
        : !matchingMedia ? 'Repository updated. Reopen its detail for the current summary.' : null : null}
    loading={summaryText === undefined && !source.readmeFull && query.isPending}
    errorMessage={summaryText === undefined && !source.readmeFull && query.error instanceof Error ? query.error.message : null}
    onRetry={summaryText === undefined || (query.isError && !query.isFetching) ? () => void query.refetch() : undefined} readmeSource={{ fullName: source.fullName, githubUrl: source.githubUrl,
      readmeBaseUrl: source.readmeBaseUrl, readmeDefaultBranch: source.readmeDefaultBranch,
      readmeSourcePath: source.readmeSourcePath }} />;
}
