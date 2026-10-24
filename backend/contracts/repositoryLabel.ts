/** Public evidence only. Colors, icons and translated copy belong to the client. */
export type RepositoryLabel =
  | { kind: 'trending'; rank: number; period: 'daily'; source: 'github-trending'; observed_at: string; expires_at: string }
  | { kind: 'recent_likes'; count: number; rank: number; window_hours: 168; observed_at: string; expires_at: string }
  | { kind: 'popular'; star_count: number; observed_at: string; expires_at: string };

export type RepositoryLabelLoader = (repoIds: string[]) => Promise<ReadonlyMap<string, RepositoryLabel>>;
