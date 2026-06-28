import type { Repository } from "@/types/repository";

const readmeFull =
  "gh-social is a social-first platform that reimagines GitHub as an engaging space for developers to discover, share, and collaborate on projects. Instead of traditional repository browsing, users can explore personalized feeds, trending repositories, and developer profiles in a familiar social media-style experience.\n\nThe platform encourages meaningful interactions through project showcases, discussions, and community engagement while making open-source discovery more accessible and enjoyable. Built with a modern, responsive interface, gh-social aims to bridge the gap between coding and social networking, helping developers connect, learn from one another, and grow together within a vibrant open-source ecosystem.\n\nBy blending social media interactions with GitHub's collaborative ecosystem, gh-social creates a space where developers can learn, collaborate, gain inspiration, and grow.";

export const repositories: Repository[] = [
  {
    id: "gh-social",
    title: "gh-social",
    description:
      "A social platform that transforms GitHub into an engaging developer community. Discover projects, connect with builders, and showcase your work effortlessly.",
    owner: "acm_vit",
    stars: "1.2k",
    watchers: "5k",
    forks: "2k",
    likes: 1000,
    dislikes: 200,
    techStack: ["React", "MongoDB", "Tailwind", "Javascript", "Python", "Android SDK"],
    readmeSummary:
      "gh-social is a social-first platform that reimagines GitHub by making project discovery and developer interactions more engaging. Explore trending repositories and collaborate through a personalized feed designed to make open source more fun.",
    readmeFull
  },
  {
    id: "repo-lens",
    title: "repo-lens",
    description:
      "A discovery layer for engineers to scan project health, explore maintainers, and follow active work across open-source communities.",
    owner: "open-labs",
    stars: "940",
    watchers: "3k",
    forks: "760",
    likes: 870,
    dislikes: 118,
    techStack: ["React", "Tailwind", "Python", "MongoDB", "Javascript", "Android SDK"],
    readmeSummary:
      "repo-lens helps developers understand projects at a glance with readable summaries, activity signals, and social context for each repository.",
    readmeFull
  },
  {
    id: "commit-flow",
    title: "commit-flow",
    description:
      "A mobile-first repository timeline that helps teams highlight releases, pull requests, issues, and project milestones in one smooth feed.",
    owner: "devcircle",
    stars: "2.1k",
    watchers: "8k",
    forks: "1.4k",
    likes: 1400,
    dislikes: 162,
    techStack: ["React", "Javascript", "Tailwind", "Python", "MongoDB", "Android SDK"],
    readmeSummary:
      "commit-flow turns repository activity into a polished vertical timeline so maintainers and followers can keep up with project movement quickly.",
    readmeFull
  }
];
