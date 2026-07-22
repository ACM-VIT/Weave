import { REPOSITORIES, type RepositoryData } from './repositories';

export type PreviewProfileBoard = {
  board_id: string;
  name: string;
  description: string;
  repo_count: number;
  repositoryTitles: string[];
};

export const PREVIEW_PROFILE_BOARDS: PreviewProfileBoard[] = [
  {
    board_id: 'preview-open-source',
    name: 'Open Source',
    description: 'Community projects worth contributing to',
    repo_count: 2,
    repositoryTitles: ['gh-social', 'opensource-hub'],
  },
  {
    board_id: 'preview-ai-tools',
    name: 'AI & Automation',
    description: 'Developer tools powered by AI',
    repo_count: 1,
    repositoryTitles: ['ai-assistant'],
  },
  {
    board_id: 'preview-learning',
    name: 'Learning',
    description: 'Resources to revisit and study',
    repo_count: 1,
    repositoryTitles: ['interview-prep'],
  },
];

export function getPreviewBoardRepositories(boardId: string): RepositoryData[] {
  const board = PREVIEW_PROFILE_BOARDS.find((item) => item.board_id === boardId);
  if (!board) return [];
  const titles = new Set(board.repositoryTitles);
  return REPOSITORIES.filter((repository) => titles.has(repository.title));
}
