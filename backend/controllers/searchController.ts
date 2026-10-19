import axios from 'axios';
import type { Response } from 'express';
import { getMlRuntimeConfig } from '../config/ml.js';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import { PostgresSearchPersistence } from '../adapters/postgresSearchPersistence.js';
import { RedisSearchSnapshotStore } from '../adapters/redisSearchSnapshotStore.js';
import redisClient from '../config/redis.js';
import { SearchService, SearchRateLimitError, parseSearchRequest, type SearchRequest } from '../services/searchService.js';
import { SearchRequestGuard } from '../services/searchRequestGuard.js';
import { sendControllerError, sendError, sendSuccess } from '../utils/response.js';

export async function semanticSearch(request: SearchRequest, signal?: AbortSignal) {
  const config = getMlRuntimeConfig();
  const { group: _group, cursor: _cursor, ...contract } = request;
  const response = await axios.post(`${config.baseUrl}/api/v2/search/repositories`, { ...contract, limit: 100 }, {
    headers: { 'X-Internal-Secret': config.internalSecret },
    timeout: 1800, signal, maxContentLength: config.maxResponseBytes, maxBodyLength: 100_000,
    maxRedirects: 0,
  });
  return response.data;
}
export const searchService = new SearchService(new PostgresSearchPersistence(), semanticSearch, Date.now, new RedisSearchSnapshotStore(redisClient));
const searchGuard = new SearchRequestGuard(redisClient);
export async function search(req: AuthRequest, res: Response): Promise<void> {
  if (!req.user?.userId) return sendError(res,401,'Authentication required.');
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', cancel);
  let release: (() => Promise<void>) | undefined;
  try {
    const request = parseSearchRequest(req.body);
    release = await searchGuard.acquire(req.user.userId);
    const result = await searchService.search(req.user.userId,request,controller.signal);
    if (!controller.signal.aborted) sendSuccess(res,200,result);
  } catch (error) {
    if (error instanceof SearchRateLimitError) res.setHeader('Retry-After', '60');
    if (!controller.signal.aborted) sendControllerError(res,error);
  }
  finally {
    res.removeListener('close',cancel);
    if (release) await release().catch(error => console.error('[Search] Could not release request lease:', error));
  }
}
