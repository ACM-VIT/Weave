/** Public source labels only; never display raw ranking channels or scores. */
const RECOMMENDATION_REASONS = {
  semantic: 'Related to your interests.',
  personalized: 'Recommended for your feed.',
  trending: 'Trending on GitHub.',
  popular: 'Popular on GitHub.',
  fresh: 'Recently active on GitHub.',
  fallback: 'Explore a repository from our catalog.',
  unknown: 'Explore this repository.',
} as const;

export type RecommendationSource = keyof typeof RECOMMENDATION_REASONS;

export function recommendationSource(value: unknown): RecommendationSource {
  return typeof value === 'string' && Object.hasOwn(RECOMMENDATION_REASONS, value)
    ? value as RecommendationSource : 'unknown';
}

export function recommendationReason(source: RecommendationSource): string {
  return RECOMMENDATION_REASONS[source];
}
