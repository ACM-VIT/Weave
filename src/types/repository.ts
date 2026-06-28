export type TechName = "React" | "MongoDB" | "Tailwind" | "Javascript" | "Python" | "Android SDK";

export interface Repository {
  id: string;
  title: string;
  description: string;
  owner: string;
  stars: string;
  watchers: string;
  forks: string;
  likes: number;
  dislikes: number;
  techStack: TechName[];
  readmeSummary: string;
  readmeFull: string;
}
