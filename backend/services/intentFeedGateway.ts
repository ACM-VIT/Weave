import type { FeedRequestV2, FeedResponseV2 } from '../contracts/feed.v2.js';
import type { FeedIntentScope } from '../contracts/feedIntent.js';
import { ModelOperationError } from '../contracts/modelOperations.js';
import type { FeedPersistencePort } from '../ports/feedPersistencePort.js';
import type { FeedV2Service } from './feedV2Service.js';
import type { FeedIntentScopeService } from './feedIntentScopeService.js';
import { FeedCursorCodec, StaleFeedCursorError } from './feedCursor.js';
type FeedService = Pick<FeedV2Service, 'getFeed' | 'stop'>;
interface ScopedFeed { scope: FeedIntentScope; service: FeedService; active: number }

/** Bounded process slots accelerate scopes whose canonical input survives in SQL. */
export class IntentFeedGateway {
  private readonly slots = new Map<string, ScopedFeed>();
  private stopping = false;
  private readonly inFlight = new Set<Promise<FeedResponseV2>>();
  private readonly cursor: FeedCursorCodec;
  constructor(private readonly legacy: FeedService,
    private readonly persistence: Pick<FeedPersistencePort, 'getServeByRequest'>,
    private readonly scopes: Pick<FeedIntentScopeService, 'snapshot' | 'resolve' | 'restoreCursor'>,
    private readonly create: (scope: FeedIntentScope) => FeedService, cursorSecret?: string) {
    this.cursor = new FeedCursorCodec(cursorSecret);
  }
  getFeed(userId: string, request: FeedRequestV2, signal?: AbortSignal): Promise<FeedResponseV2> {
    if (this.stopping || this.inFlight.size >= 256) return Promise.reject(new ModelOperationError());
    const operation = this.prepare(userId, request, signal);
    this.inFlight.add(operation);
    void operation.finally(() => this.inFlight.delete(operation)).catch(() => {});
    return operation;
  }
  private scopeKey(scope: Pick<FeedIntentScope, 'userId' | 'sessionId' | 'feedVersion' | 'profileVersion' | 'acceptedOperationVersion' | 'epoch' | 'policySha256' | 'witnessSha256'>): string {
    return JSON.stringify([scope.userId, scope.sessionId, scope.feedVersion, scope.profileVersion,
      scope.acceptedOperationVersion, scope.epoch, scope.policySha256, scope.witnessSha256]);
  }
  private currentSlot(key: string): ScopedFeed | undefined {
    return [...this.slots.values()].find(slot => this.scopeKey(slot.scope) === key
      && BigInt(slot.scope.applied.valid_until_ms) > BigInt(Date.now()));
  }
  private async prepare(userId: string, request: FeedRequestV2, signal?: AbortSignal): Promise<FeedResponseV2> {
    if (this.stopping) throw new ModelOperationError();
    // Historical authenticated replay precedes current epoch/expiry admission.
    if (await this.persistence.getServeByRequest(userId, request.feed_request_id)) return this.legacy.getFeed(userId, request, signal);
    let snapshot: Awaited<ReturnType<FeedIntentScopeService['snapshot']>>;
    try { snapshot = await this.scopes.snapshot(userId, request.session_id); }
    catch (error) {
      if (request.cursor !== null && error instanceof ModelOperationError && error.code === 'MODEL_SESSION_PENDING') throw new StaleFeedCursorError();
      throw error;
    }
    if (!snapshot) return this.legacy.getFeed(userId, request, signal);
    for (const [key, slot] of this.slots) {
      if (slot.active === 0 && BigInt(slot.scope.applied.valid_until_ms) <= BigInt(Date.now())) {
        this.slots.delete(key);
        await slot.service.stop();
      }
    }
    const base = this.scopeKey(snapshot);
    const signedScope = request.cursor === null ? null : this.cursor.modelScope(request.cursor, {
      user_id: userId, session_id: request.session_id, feed_version: snapshot.feedVersion,
    });
    if (request.cursor !== null && !signedScope) throw new StaleFeedCursorError();
    // Never derive a continuation clock from the client or a process-local cache.
    const restored = signedScope ? await this.scopes.restoreCursor(snapshot, signedScope) : null;
    let slot = signedScope ? this.slots.get(signedScope) : this.currentSlot(base);
    const scope = await this.scopes.resolve(userId, request.session_id, restored?.as_of_ms ?? slot?.scope.context.as_of_ms);
    if (!scope || this.stopping) throw new ModelOperationError();
    if (signedScope && scope.queueScope !== signedScope) throw new StaleFeedCursorError();
    // A concurrent cold reader may have installed the same logical scope meanwhile.
    slot = signedScope ? this.slots.get(signedScope) : this.currentSlot(this.scopeKey(scope));
    if (slot && (slot.scope.applied.head !== scope.applied.head || slot.scope.applied.state_sha256 !== scope.applied.state_sha256
      || BigInt(slot.scope.applied.valid_until_ms) <= BigInt(Date.now()))) throw new StaleFeedCursorError();
    if (!slot) {
      if (this.slots.size >= 128) throw new ModelOperationError('MODEL_FEED_CAPACITY', 503);
      slot = { scope, service: this.create(scope), active: 0 };
      this.slots.set(scope.queueScope, slot);
    }
    slot.active++;
    try { return await slot.service.getFeed(userId, request, signal); }
    finally { slot.active--; }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.inFlight]);
    await Promise.allSettled([this.legacy.stop(), ...[...this.slots.values()].map(slot => slot.service.stop())]);
    this.slots.clear();
  }
}
