import { FEEDBACK_ACTIONS } from '../constants/feedbackActions';
import type { ActivityInput } from '../api/activity';
import { normalizeGitHubRepositoryUrl } from '../utils/repository-links';

type OpenedTab = {
  opener: unknown;
  location: { replace: (url: string) => void };
  close: () => void;
};

type OpenDependencies = {
  open: (url: string) => Promise<unknown>;
  platform?: string;
  browser?: { open: (url: string, target: string) => OpenedTab | null };
  onOpened?: () => unknown | Promise<unknown>;
  outbox?: { enqueue: (event: ActivityInput) => Promise<unknown>; flush: (token: string) => Promise<unknown> } | null;
  token?: () => Promise<string | null>;
};

export async function openRepositoryOnGitHub(repoId: string, url: string, dependencies: OpenDependencies): Promise<boolean> {
  const destination = normalizeGitHubRepositoryUrl(url);
  if (!destination) return false;
  try {
    if (dependencies.platform === 'web') {
      // RN Web Linking resolves even for a blocked popup. Opening a blank tab
      // lets us detect that failure and sever opener access before navigation.
      // The `noopener` window feature cannot be used: it returns null on success.
      const tab = dependencies.browser?.open('about:blank', '_blank');
      if (!tab) return false;
      try {
        tab.opener = null;
        tab.location.replace(destination);
      } catch (error) {
        try { tab.close(); } catch { /* The browser may already have closed it. */ }
        throw error;
      }
    } else {
      await dependencies.open(destination);
    }
  }
  catch { return false; }
  try { await dependencies.onOpened?.(); }
  catch { /* Feedback persistence failure does not undo an external opening. */ }
  if (dependencies.outbox) {
    try {
      await dependencies.outbox.enqueue({ repo_id: repoId, action: FEEDBACK_ACTIONS.githubOpen });
      const token = await dependencies.token?.();
      if (token) await dependencies.outbox.flush(token);
    } catch {
      // Delivery failure must preserve the successful open and the durable queued event.
    }
  }
  return true;
}
