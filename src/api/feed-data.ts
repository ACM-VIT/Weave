import type { FeedPage } from '../services/feedPagination';
import { recommendationSource } from '../models/recommendation';

export type FeedResponseV2 = {
  serve_id: string;
  feed_version: string;
  source?: unknown;
  items: { repo_id: string; position: number; source?: unknown; repository: Record<string, unknown> }[];
  next_cursor: string | null;
};

/** Preserve serve attribution when flattening the backend's nested response. */
export function decodeFeedPage(data: FeedResponseV2, sessionId: string): FeedPage {
  return {
    items: data.items.map(item => ({
      ...item.repository, repo_id: item.repo_id, position: item.position,
      serve_id: data.serve_id, feed_version: data.feed_version,
      feed_session_id:sessionId, client_original_impression:null,
      // A known item channel is more specific than the whole serve's source.
      // Unknown future channels receive neutral copy, never a guessed rationale.
      recommendation_source: recommendationSource(item.source ?? data.source),
    })),
    nextCursor: data.next_cursor,
    feedVersion: data.feed_version,
    sessionId,
  };
}
