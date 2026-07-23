export interface RepositoryUpsert {
  github_id: string;
  github_node_id?: string | null;
  full_name: string;
  owner: string;
  name: string;
  url: string;
  description?: string | null;
  readme?: string | null;
  readme_length?: number;
  primary_language?: string | null;
  languages?: string[];
  topics?: string[];
  star_count?: number;
  fork_count?: number;
  open_issues_count?: number;
  pushed_days_ago?: number;
  delta_3d?: number;
  delta_7d?: number;
  delta_30d?: number;
  mentionable_users_count?: number;
  readme_to_codebase_ratio?: number;
  recent_commits?: string[];
  created_at?: string | null;
  updated_at?: string | null;
  pushed_at?: string | null;
  discovery_category?: string | null;
  discovery_band?: string | null;
  observed_at: string;
}

export interface RepositoryUpsertResult {
  github_id: string;
  repo_id: string;
  content_version: number;
  changed: boolean;
}

export interface TrendingSnapshotInput {
  snapshot_id: string;
  period: string;
  computed_at: string;
  source: string;
  repositories: Array<RepositoryUpsert & { rank: number; score?: number | null }>;
}

export interface TrendingSnapshotResult {
  snapshot_id: string;
  repository_count: number;
  activated_at: string;
}
