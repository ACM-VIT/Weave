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
  const query = useRepositoryReadme(repository, summaryText === undefined || !manifestMatchesSummary);
  const source = query.data ?? (query.terminalError ? {...repository,readmeFull:null} : repository);
  const matchingMedia = summaryText === undefined || source.contentVersion === expectedVersion
    && (!expectedHash || source.contentHash === expectedHash);
  const media = matchingMedia ? source.readmeFull : null;
  const manifestMedia = manifestMatchesSummary ? manifest : null;
  return <ReadmePopup isVisible onClose={onClose} title={repository.name} contentKind={summaryText === undefined ? "readme" : "summary"}
    readmeText={summaryText === undefined ? source.readmeFull : summaryText} mediaMarkdown={media}
    mediaImages={manifestMedia?.images} mediaVideos={manifestMedia?.videos}
    mediaMessage={summaryText !== undefined && !media && !manifestMedia
      ? !matchingMedia ? 'Repository updated. Reopen its detail for the current summary.' : query.isError ? 'Could not load README videos.' : query.isPending ? 'Checking README for videos…' : null : null}
    loading={summaryText === undefined && !source.readmeFull && query.isPending}
    errorMessage={summaryText === undefined && !source.readmeFull && query.error instanceof Error ? query.error.message : null}
    onRetry={() => void query.refetch()} readmeSource={{ fullName: source.fullName, githubUrl: source.githubUrl,
      readmeBaseUrl: source.readmeBaseUrl, readmeDefaultBranch: source.readmeDefaultBranch,
      readmeSourcePath: source.readmeSourcePath }} />;
}
