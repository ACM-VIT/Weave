import { observeMetric } from './metrics.js';

const measured = new Set([
  'getGenerationContext', 'getFeedVersion', 'getServeByRequest', 'createServe',
  'listCandidateEligibility', 'listActiveRepositories', 'listActiveRepositoryIdentities',
  'listExcludedRepositoryIds', 'listServedRepositoryIds', 'listPreferenceEligibleRepositoryIds',
  'listExposureEligibleRepositoryIds', 'getRecentPersonalizedEntries',
  'listSocialRepositoryCandidates', 'listFollowedRepositoryIds', 'recordGenerationAttempt',
]);

/** Fixed operation labels only; never record SQL, parameters or product identities. */
export function measureFeedPersistence<T extends object>(persistence: T, configure?: (raw: T) => void): T {
  // Bind scoped overrides to the raw adapter so only the final operation is timed.
  configure?.(persistence);
  return new Proxy(persistence, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (typeof property !== 'string' || !measured.has(property)) return value.bind(target);
      return async (...args: unknown[]) => {
        const started = performance.now();
        let outcome = 'success';
        try { return await value.apply(target, args); }
        catch (error) { outcome = 'failure'; throw error; }
        finally { observeMetric('feed_persistence_duration_ms', performance.now() - started, { operation: property, outcome }); }
      };
    },
  });
}
