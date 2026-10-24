import { Star, ThumbsUp, TrendingUp } from 'lucide-react-native';
import type { RepositoryLabel } from '../../models/repository-label';
import { REFERENCE_THEME } from '../../constants/theme';

type LabelPresentation<K extends RepositoryLabel['kind']> = {
  icon: typeof Star;
  tone: { color: string; backgroundColor: string; borderColor: string };
  text: (label: Extract<RepositoryLabel, { kind: K }>) => string;
  accessibilityLabel: (label: Extract<RepositoryLabel, { kind: K }>) => string;
};

/** One extension point for every supported kind's copy, icon and semantic tone. */
export const REPOSITORY_LABEL_PRESENTATION = {
  trending: {
    icon: TrendingUp,
    tone: REFERENCE_THEME.repositoryLabel.trending,
    text: (label) => `Trending #${label.rank} on GitHub`,
    accessibilityLabel: (label) => `Number ${label.rank} on GitHub’s daily trending list`,
  },
  recent_likes: {
    icon: ThumbsUp,
    tone: REFERENCE_THEME.repositoryLabel.recentLikes,
    text: () => 'Most liked · 7d',
    accessibilityLabel: (label) => `One of the most liked repositories on Weave in the last seven days, with ${label.count.toLocaleString('en-US')} likes`,
  },
  popular: {
    icon: Star,
    tone: REFERENCE_THEME.repositoryLabel.popular,
    text: () => 'Popular on GitHub',
    accessibilityLabel: (label) => `Popular on GitHub, with ${label.star_count.toLocaleString('en-US')} stars`,
  },
} satisfies { [K in RepositoryLabel['kind']]: LabelPresentation<K> };

export function repositoryLabelPresentation(label: RepositoryLabel) {
  // Narrowing here keeps new kinds exhaustively checked, including their copy.
  switch (label.kind) {
    case 'trending': return { ...REPOSITORY_LABEL_PRESENTATION.trending,
      text: REPOSITORY_LABEL_PRESENTATION.trending.text(label),
      accessibilityLabel: REPOSITORY_LABEL_PRESENTATION.trending.accessibilityLabel(label) };
    case 'recent_likes': return { ...REPOSITORY_LABEL_PRESENTATION.recent_likes,
      text: REPOSITORY_LABEL_PRESENTATION.recent_likes.text(),
      accessibilityLabel: REPOSITORY_LABEL_PRESENTATION.recent_likes.accessibilityLabel(label) };
    case 'popular': return { ...REPOSITORY_LABEL_PRESENTATION.popular,
      text: REPOSITORY_LABEL_PRESENTATION.popular.text(),
      accessibilityLabel: REPOSITORY_LABEL_PRESENTATION.popular.accessibilityLabel(label) };
  }
}
