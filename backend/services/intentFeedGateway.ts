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
  private readonly retiring = new Set<Promise<void>>();
  private readonly inFlight = new Set<Promise<FeedResponseV2>>();
  private readonly cursor: FeedCursorCodec;
  constructor(private readonly legacy: FeedService,
    private readonly persistence: Pick<FeedPersistencePort, 'getServeByRequest'>,
    private readonly scopes: Pick<FeedIntentScopeService, 'snapshot' | 'resolve' | 'restoreCursor'>,
    private readonly create: (scope: FeedIntentScope) => FeedService, cursorSecret?: string,
    private readonly capacityWaitMs = 1_500) {
    if (!Number.isSafeInteger(capacityWaitMs) || capacityWaitMs < 1) throw new RangeError('Invalid feed capacity wait.');
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
  private retire(key:string,slot:ScopedFeed):Promise<void> {
    if(this.slots.get(key)!==slot||slot.active!==0)return Promise.resolve();
    this.slots.delete(key);
    const drain=Promise.resolve().then(()=>slot.service.stop()).finally(()=>this.retiring.delete(drain));
    this.retiring.add(drain);
    return drain;
  }
  private waitForRetirement(work:Promise<void>,remainingMs:number,signal?:AbortSignal):Promise<void> {
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(failed:boolean,error?:unknown)=>{
        if(settled)return;
        settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(failed)reject(error);else resolve();
      };
      const abort=()=>finish(true,signal?.reason);
      const timer=setTimeout(()=>finish(true,new ModelOperationError('MODEL_FEED_CAPACITY',503)),remainingMs);
      signal?.addEventListener('abort',abort,{once:true});
      work.then(()=>finish(false),error=>finish(true,error));
      if(signal?.aborted)abort();
    });
  }
  private async makeRoom(signal?:AbortSignal):Promise<void> {
    const deadline=performance.now()+this.capacityWaitMs;
    while(this.slots.size+this.retiring.size>=128){
      signal?.throwIfAborted();
      const remaining=deadline-performance.now();
      if(remaining<=0)throw new ModelOperationError('MODEL_FEED_CAPACITY',503);
      const idle=[...this.slots].find(([,slot])=>slot.active===0);
      const work=idle?this.retire(...idle):this.retiring.size?Promise.race(this.retiring):null;
      if(!work)throw new ModelOperationError('MODEL_FEED_CAPACITY',503);
      await this.waitForRetirement(work,remaining,signal);
      if(this.stopping)throw new ModelOperationError();
    }
  }
  private async prepare(userId: string, request: FeedRequestV2, signal?: AbortSignal): Promise<FeedResponseV2> {
    signal?.throwIfAborted();
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
    for (const [key, slot] of [...this.slots]) {
      if (slot.active === 0 && BigInt(slot.scope.applied.valid_until_ms) <= BigInt(Date.now())) {
        // stop() can own a slow background refill. Retain its capacity reservation
        // while allowing unrelated ready requests to use other available slots.
        void this.retire(key,slot).catch(()=>console.warn('[IntentFeedGateway] Expired scope retirement failed.'));
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
    signal?.throwIfAborted();
    if (!scope || this.stopping) throw new ModelOperationError();
    if (signedScope && scope.queueScope !== signedScope) throw new StaleFeedCursorError();
    // A concurrent cold reader may have installed the same logical scope meanwhile.
    slot = signedScope ? this.slots.get(signedScope) : this.currentSlot(this.scopeKey(scope));
    if (slot && (slot.scope.applied.head !== scope.applied.head || slot.scope.applied.state_sha256 !== scope.applied.state_sha256
      || BigInt(slot.scope.applied.valid_until_ms) <= BigInt(Date.now()))) throw new StaleFeedCursorError();
    while (!slot) {
      await this.makeRoom(signal);
      signal?.throwIfAborted();
      if(this.stopping)throw new ModelOperationError();
      // A peer may restore this same durable scope while an idle service drains.
      slot=this.slots.get(scope.queueScope);
      if(!slot&&this.slots.size+this.retiring.size<128){
        slot = { scope, service: this.create(scope), active: 0 };this.slots.set(scope.queueScope, slot);
      }
    }
    slot.active++;
    try { return await slot.service.getFeed(userId, request, signal); }
    finally { slot.active--; }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.inFlight]);
    await Promise.allSettled([this.legacy.stop(), ...this.retiring, ...[...this.slots.values()].map(slot => slot.service.stop())]);
    this.slots.clear();
  }
}
