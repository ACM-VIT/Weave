export interface Repo {
  id: string;
  name: string;
  stars: string;
  forks: string;
  author: string;
  avatarColor: string;
  avatarGradient?: readonly [string, string];
  avatarInitial: string;
  hasIcon?: boolean;
  language?: string;
  description?: string;
  trendingPeriod?: FilterPeriod;
  url?: string;
}

export type TabName = 'Latest' | 'Trending';
export type NavItem = 'home' | 'explore' | 'profile';

export type FilterPeriod = 'Today' | 'This week' | 'This month';
export type FilterLanguage = 'All' | 'Python' | 'TypeScript' | 'JavaScript' | 'Rust' | 'Go';
