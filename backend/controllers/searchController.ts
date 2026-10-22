import crypto from 'node:crypto';
import { startSpan, httpOutcome } from '../observability/tracing.js';
import type { StageOutcome } from '../observability/metrics.js';
import axios from 'axios';
import type { Response } from 'express';
import { getMlRuntimeConfig } from '../config/ml.js';
import type { AuthRequest } from '../middlewares/authMiddleware.js';
import { PostgresSearchPersistence } from '../adapters/postgresSearchPersistence.js';
import { RedisSearchSnapshotStore } from '../adapters/redisSearchSnapshotStore.js';
import redisClient from '../config/redis.js';
import { SearchService, SearchRateLimitError, parseSearchRequest, parseSemanticResponse, type SearchRequest } from '../services/searchService.js';
import { SemanticSearchCircuit } from '../services/semanticSearchCircuit.js';
import { SearchRequestGuard } from '../services/searchRequestGuard.js';
import { sendControllerError, sendError, sendSuccess } from '../utils/response.js';

const semanticCircuit = new SemanticSearchCircuit();
export async function semanticSearch(request: SearchRequest, signal?: AbortSignal) {
  return semanticCircuit.run(async attemptSignal => {
    const config = getMlRuntimeConfig();
    const { group: _group, cursor: _cursor, ...contract } = request;
    const span = startSpan('search', 'ml_transport');
    let outcome: StageOutcome = 'failure';
    try {
      const response = await axios.post(`${config.baseUrl}/api/v2/search/repositories`, { ...contract, limit: 100 }, {
        headers: { 'X-Internal-Secret': config.internalSecret, 'x-request-id': crypto.randomUUID(), traceparent: span.traceparent },
        timeout: 1800, signal: attemptSignal, maxContentLength: config.maxResponseBytes, maxBodyLength: 100_000,
        maxRedirects: 0,
      });
      // An invalid envelope must not close a half-open circuit.
      parseSemanticResponse(response.data, request.search_id);
      outcome = httpOutcome(response.status);
      return response.data;
    } catch (error) {
      outcome = signal?.aborted ? 'cancelled'
        : attemptSignal.aborted || (axios.isAxiosError(error) && error.code === 'ECONNABORTED') ? 'timeout'
        : axios.isAxiosError(error) && error.response ? httpOutcome(error.response.status) : 'failure';
      throw error;
    } finally {
      span.finish(signal?.aborted ? 'cancelled' : attemptSignal.aborted ? 'timeout' : outcome);
    }
  }, signal);
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
