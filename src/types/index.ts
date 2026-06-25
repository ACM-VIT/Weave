export interface Repo {
  id: string;
  name: string;
  stars: string;
  forks: string;
  author: string;
  avatarColor: string;
  avatarInitial: string;
  hasIcon?: boolean;
  language?: string;
  description?: string;
  trendingPeriod?: FilterPeriod;
}

export type TabName = 'For you' | 'Trending';
export type NavItem = 'home' | 'explore' | 'profile';

export type FilterPeriod = 'Today' | 'This week' | 'This month';
export type FilterLanguage = 'All' | 'Python' | 'TypeScript' | 'JavaScript' | 'Rust' | 'Go';