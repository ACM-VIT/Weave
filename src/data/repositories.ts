export type RepositoryData = {
  id: string;
  serveId?: string | null;
  feedPosition?: number | null;
  viewerReaction?: 'like' | 'dislike' | null;
  viewerSaved?: boolean;
  title: string;
  owner: string;
  githubUrl?: string;
  description: string;
  readmeSummary: string;
  readmeFull: string;
  stats: {
    stars: string;
    views: string;
    bugs: string;
    forks: string;
    likes?: string;
    comments?: string;
  };
  updatedText: string;
  techStack?: string[];
};
