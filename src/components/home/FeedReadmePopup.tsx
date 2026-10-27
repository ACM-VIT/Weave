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
  const query = useRepositoryReadme(repository,true);
  const source = query.data ?? (query.terminalError ? {...repository,readmeFull:null} : repository);
  const matchingMedia = summaryText === undefined || source.contentVersion === (summaryVersion ?? repository.contentVersion)
    && (!summaryHash || source.contentHash === summaryHash);
  const media = matchingMedia ? source.readmeFull : null;
  return <ReadmePopup isVisible onClose={onClose} title={repository.name} contentKind={summaryText === undefined ? "readme" : "summary"}
    readmeText={summaryText === undefined ? source.readmeFull : summaryText} mediaMarkdown={media}
    mediaMessage={summaryText !== undefined && !media
      ? !matchingMedia ? 'Repository updated. Reopen its detail for the current summary.' : query.isError ? 'Could not load README videos.' : query.isPending ? 'Checking README for videos…' : null : null}
    loading={summaryText === undefined && !source.readmeFull && query.isPending}
    errorMessage={summaryText === undefined && !source.readmeFull && query.error instanceof Error ? query.error.message : null}
    onRetry={() => void query.refetch()} readmeSource={{ fullName: source.fullName, githubUrl: source.githubUrl,
      readmeBaseUrl: source.readmeBaseUrl, readmeDefaultBranch: source.readmeDefaultBranch,
      readmeSourcePath: source.readmeSourcePath }} />;
}
