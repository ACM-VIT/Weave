import type { RepositoryLabel, RepositoryLabelLoader } from '../contracts/repositoryLabel.js';

const HOUR = 3_600_000;
/** Product defaults, centralized so another label is one rule and evidence loader. */
export const REPOSITORY_LABEL_POLICY = Object.freeze({
  trendingTop: 10, trendingFreshnessMs: 36 * HOUR,
  recentLikesTop: 10, recentLikesMinimum: 20, recentLikesWindowHours: 168 as const,
  recentLikesCacheMs: 60_000, popularMinimumStars: 1_000, starsFreshnessMs: 7 * 24 * HOUR,
  requestBudgetMs: 150, queryTimeoutMs: 100, concurrentLoads: 3,
});

export interface RepositoryLabelEvidence {
  repo_id: string;
  trending_rank?: number | null;
  trending_observed_at?: string | Date | null;
  star_count?: number | null;
  stats_observed_at?: string | Date | null;
}
export interface RecentLikesEvidence { repo_id: string; count: number; rank: number }
export interface RepositoryLabelSource {
  repositories(repoIds: string[]): Promise<readonly RepositoryLabelEvidence[]>;
  recentLikes(referenceTime: Date): Promise<readonly RecentLikesEvidence[]>;
}
interface RuleContext { evidence: RepositoryLabelEvidence; likes?: RecentLikesEvidence; likesObservedAt: number; now: number }
type LabelRule = (context: RuleContext) => RepositoryLabel | null;
const iso = (time: number) => new Date(time).toISOString();
function observed(value: string | Date | null | undefined, now: number, freshness: number): number | null {
  const time = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(time) && time <= now && now < time + freshness ? time : null;
}
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** First eligible rule wins. Retrieval source is intentionally not an input. */
export const REPOSITORY_LABEL_RULES: readonly LabelRule[] = [
  ({ evidence, now }) => {
    const time = observed(evidence.trending_observed_at, now, REPOSITORY_LABEL_POLICY.trendingFreshnessMs);
    return time !== null && positiveInteger(evidence.trending_rank) && evidence.trending_rank <= REPOSITORY_LABEL_POLICY.trendingTop
      ? { kind: 'trending', rank: evidence.trending_rank, period: 'daily', source: 'github-trending',
        observed_at: iso(time), expires_at: iso(time + REPOSITORY_LABEL_POLICY.trendingFreshnessMs) } : null;
  },
  ({ likes, likesObservedAt, now }) => {
    const time = observed(new Date(likesObservedAt), now, REPOSITORY_LABEL_POLICY.recentLikesCacheMs);
    return time !== null && likes && positiveInteger(likes.rank) && likes.rank <= REPOSITORY_LABEL_POLICY.recentLikesTop
      && positiveInteger(likes.count) && likes.count >= REPOSITORY_LABEL_POLICY.recentLikesMinimum
      ? { kind: 'recent_likes', count: likes.count, rank: likes.rank, window_hours: REPOSITORY_LABEL_POLICY.recentLikesWindowHours,
        observed_at: iso(time), expires_at: iso(time + REPOSITORY_LABEL_POLICY.recentLikesCacheMs) } : null;
  },
  ({ evidence, now }) => {
    const time = observed(evidence.stats_observed_at, now, REPOSITORY_LABEL_POLICY.starsFreshnessMs);
    return time !== null && positiveInteger(evidence.star_count) && evidence.star_count >= REPOSITORY_LABEL_POLICY.popularMinimumStars
      ? { kind: 'popular', star_count: evidence.star_count, observed_at: iso(time),
        expires_at: iso(time + REPOSITORY_LABEL_POLICY.starsFreshnessMs) } : null;
  },
];

export function selectRepositoryLabel(evidence: RepositoryLabelEvidence, now: number,
  likes?: RecentLikesEvidence, likesObservedAt = now): RepositoryLabel | null {
  for (const rule of REPOSITORY_LABEL_RULES) {
    const label = rule({ evidence, now, likes, likesObservedAt });
    if (label) return label;
  }
  return null;
}

/** Public, per-process cache of a corpus-wide top ten; never viewer-specific. */
export class RepositoryLabelService {
  private activeLoads = 0;
  private likes?: { observedAt: number; rows: readonly RecentLikesEvidence[] };
  private likesPending?: Promise<void>;
  private likesRetryAfter = 0;
  constructor(private readonly source: RepositoryLabelSource, private readonly now = Date.now) {}

  private async refreshLikes(now: number): Promise<void> {
    if (this.likes && now >= this.likes.observedAt && now < this.likes.observedAt + REPOSITORY_LABEL_POLICY.recentLikesCacheMs) return;
    if (this.likesPending) return this.likesPending;
    if (now < this.likesRetryAfter) return;
    const work = Promise.resolve().then(() => this.source.recentLikes(new Date(now)))
      .then(rows => { this.likes = { observedAt: now, rows }; })
      .catch(() => { this.likesRetryAfter = this.now() + 5_000; });
    this.likesPending = work;
    try { await work; } finally { if (this.likesPending === work) this.likesPending = undefined; }
  }

  readonly load: RepositoryLabelLoader = async repoIds => {
    const ids = [...new Set(repoIds)];
    if (!ids.length || ids.length > 100 || this.activeLoads >= REPOSITORY_LABEL_POLICY.concurrentLoads) return new Map();
    const reference = this.now();
    this.activeLoads++;
    // The real work owns admission even after a caller's optional budget expires.
    // This bounds queries waiting for a pooled connection as well as active SQL.
    const work = Promise.all([
      Promise.resolve().then(() => this.source.repositories(ids)).catch(() => [] as RepositoryLabelEvidence[]),
      this.refreshLikes(reference),
    ]).then(([rows]) => {
      const now = this.now();
      const likes = new Map(this.likes?.rows.map(row => [row.repo_id, row]));
      const requested = new Set(ids);
      const result = new Map<string, RepositoryLabel>();
      for (const row of rows) {
        if (!requested.has(row.repo_id)) continue;
        const label = selectRepositoryLabel(row, now, likes.get(row.repo_id), this.likes?.observedAt ?? reference);
        if (label) result.set(row.repo_id, label);
      }
      return result;
    }).catch(() => new Map<string, RepositoryLabel>());
    void work.finally(() => { this.activeLoads--; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<Map<string, RepositoryLabel>>(resolve => {
        timer = setTimeout(() => resolve(new Map()), REPOSITORY_LABEL_POLICY.requestBudgetMs);
      })]);
    } finally { clearTimeout(timer); }
  };
}

/** Request-owned copies preserve durable serve identity/order/provenance. */
export async function withRepositoryLabels<T extends { repo_id: string }>(rows: readonly T[], loader: RepositoryLabelLoader): Promise<Array<T & { label: RepositoryLabel | null }>> {
  let labels: ReadonlyMap<string, RepositoryLabel> = new Map();
  try { labels = await loader(rows.map(row => row.repo_id)); } catch { /* Labels never fail the feed. */ }
  return rows.map(row => ({ ...row, label: labels.get(row.repo_id) ?? null }));
}
