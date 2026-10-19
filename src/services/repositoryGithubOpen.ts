import { FEEDBACK_ACTIONS } from '../constants/feedbackActions';
import type { ActivityInput } from '../api/activity';

type OpenDependencies = {
  open: (url: string) => Promise<unknown>;
  outbox: { enqueue: (event: ActivityInput) => Promise<unknown>; flush: (token: string) => Promise<unknown> } | null;
  token: () => Promise<string | null>;
};

export async function openRepositoryOnGitHub(repoId: string, url: string, dependencies: OpenDependencies): Promise<boolean> {
  try { await dependencies.open(url); }
  catch { return false; }
  if (dependencies.outbox) {
    try {
      await dependencies.outbox.enqueue({ repo_id: repoId, action: FEEDBACK_ACTIONS.githubOpen });
      const token = await dependencies.token();
      if (token) await dependencies.outbox.flush(token);
    } catch {
      // Delivery failure must preserve the successful open and the durable queued event.
    }
  }
  return true;
}
