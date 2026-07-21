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

export const REPOSITORIES: RepositoryData[] = [
  {
    id: '47f30433-7c76-43ce-a748-75bb5ebf924d',
    title: 'gh-social',
    owner: 'acm_vit',
    description: 'A social platform that transforms GitHub into an engaging developer community. Discover projects, connect with builders, and showcase your work effortlessly.',
    readmeSummary: "gh-social is a social-first platform that reimagines GitHub by making project discovery and developer interactions more engaging.Explore trending repositories and collaborate through a personalized feed designed to make open source more fun.",
    readmeFull: "gh-social is a social-first platform that reimagines GitHub as an engaging space for developers to discover, share, and collaborate on projects. Instead of traditional repository browsing, users can explore personalized feeds, trending repositories, and developer profiles in a familiar social media-style experience.\n\nThe platform encourages meaningful interactions through project showcases, discussions, and community engagement while making open-source discovery more accessible and enjoyable. Built with a modern, responsive interface, gh-social aims to bridge the gap between coding and social networking, helping developers connect, learn from one another, and grow together within a vibrant open-source ecosystem.\n\nBy blending social media interactions with GitHub's collaborative ecosystem, gh-social creates a space where developers can learn, collaborate, gain inspiration, and grow.",
    stats: {
      stars: '1.2k',
      views: '5k',
      bugs: '12',
      forks: '2k',
    },
    updatedText: 'updated 2 days ago',
    techStack: ['React', 'MongoDB', 'Tailwind', 'Javascript', 'Python', 'Android SDK'],
  },
  {
    id: '3a3ebcc5-7099-46f3-9c9a-0dac7fc3fd4f',
    title: 'opensource-hub',
    owner: 'open-source-team',
    description: 'A centralized hub for discoverability and management of open-source contributions. Connect with maintainers, find issues, and streamline your workflow.',
    readmeSummary: 'OpenSourceHub simplifies the process of finding and contributing to projects. It features real-time issue tracking, developer matching, and customized project recommendations to help you make your first contribution.',
    readmeFull: 'OpenSourceHub simplifies the process of finding and contributing to projects. It features real-time issue tracking, developer matching, and customized project recommendations to help you make your first contribution.\n\nKey features include:\n- Skill-based issue search and filter\n- One-click contribution requests\n- Gamified contribution milestones and badges\n- Seamless integration with GitHub Actions for automated onboarding.',
    stats: {
      stars: '980',
      views: '3.6k',
      bugs: '8',
      forks: '1.5k',
    },
    updatedText: 'updated yesterday',
    techStack: ['React', 'Tailwind', 'Javascript'],
  },
  {
    id: '91d18b92-c83a-4405-9411-88523568d30f',
    title: 'ai-assistant',
    owner: 'ml-studio',
    description: 'An intelligent developer assistant that automates code generation, debugging, and project configuration. Level up your productivity with custom-tailored AI assistance.',
    readmeSummary: 'AI-Assistant integrates state-of-the-art LLMs directly with your codebase. It analyzes your work patterns, automates boring boilerplates, and provides context-aware documentation to keep you in the zone.',
    readmeFull: 'AI-Assistant integrates state-of-the-art LLMs directly with your codebase. It analyzes your work patterns, automates boring boilerplates, and provides context-aware documentation to keep you in the zone.\n\nKey features include:\n- Real-time inline code completions and suggestions\n- Automated bug-finding and fixing routines\n- Architectural pattern analysis and visual modeling\n- Intelligent docstring and documentation generation.',
    stats: {
      stars: '2.1k',
      views: '8.4k',
      bugs: '16',
      forks: '3.2k',
    },
    updatedText: 'updated 4 hours ago',
    techStack: ['Python', 'MongoDB', 'React'],
  },
  {
    id: '47f30433-7c76-43ce-a748-75bb5ebf924d',
    title: 'interview-prep',
    owner: 'career-labs',
    description: 'The ultimate resources and curriculum guide to ace your technical coding interviews. Practice algorithms, system design, and behavioral questions.',
    readmeSummary: 'InterviewPrep is a comprehensive, open-source guide containing hand-picked coding questions, interactive mock interviews, and system design roadmaps curated by senior tech leaders.',
    readmeFull: 'InterviewPrep is a comprehensive, open-source guide containing hand-picked coding questions, interactive mock interviews, and system design roadmaps curated by senior tech leaders.\n\nKey features include:\n- Standard algorithm coding patterns checklist\n- Interactive system design simulator\n- Mock behavioral interview chatbot\n- Active peer-review discussion board.',
    stats: {
      stars: '740',
      views: '2.8k',
      bugs: '5',
      forks: '1.1k',
    },
    updatedText: 'updated today',
    techStack: ['Javascript', 'Python'],
  },
];
