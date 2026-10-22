import type { RepositoryPersistencePort } from '../ports/repositoryPersistencePort.js';
import { GitHubTrendingIngestionService } from '../services/githubTrendingIngestionService.js';
import { TrendingService } from '../services/trendingService.js';

export class TrendingIngestionWorker {
  constructor(
    persistence: RepositoryPersistencePort,
    private readonly source = new GitHubTrendingIngestionService(),
  ) {
    this.trending = new TrendingService(persistence);
  }

  private readonly trending: TrendingService;

  async runOnce(): Promise<{ snapshot_id: string; repository_count: number }> {
    const snapshot = await this.source.buildSnapshot();
    const result = await this.trending.recordSnapshot(snapshot);
    return { snapshot_id: result.snapshot_id, repository_count: result.repository_count };
  }
}
