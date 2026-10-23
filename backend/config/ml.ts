export interface MlRuntimeConfig {
  baseUrl: string;
  internalSecret: string;
  timeoutMs: number;
  generationTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  onboardingTimeoutMs?: number;
  repositoryRefreshTimeoutMs?: number;
  repositoryIndexTimeoutMs?: number;
  maxResponseBytes: number;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Timer-safe values; malformed deployment settings must not become 1ms timers. */
export function mlTimeoutMs(name: string, fallback: number, environment: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`${name} must be an integer between 1 and 2147483647 milliseconds.`);
  }
  return value;
}

export function resolveMlTimeouts(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const timeoutMs = mlTimeoutMs('ML_TIMEOUT_MS', 5_000, environment);
  const deliveryTimeoutMs = mlTimeoutMs('ML_DELIVERY_TIMEOUT_MS', 30_000, environment);
  // Honor explicitly configured legacy knobs until operators approve new budgets.
  const legacyRead = environment.ML_TIMEOUT_MS?.trim() ? timeoutMs : undefined;
  const legacyDelivery = environment.ML_DELIVERY_TIMEOUT_MS?.trim() ? deliveryTimeoutMs : undefined;
  return {
    timeoutMs,
    generationTimeoutMs: mlTimeoutMs('ML_GENERATION_TIMEOUT_MS', legacyRead ?? 15_000, environment),
    deliveryTimeoutMs,
    onboardingTimeoutMs: mlTimeoutMs('ML_ONBOARDING_TIMEOUT_MS', legacyDelivery ?? 35_000, environment),
    repositoryRefreshTimeoutMs: mlTimeoutMs('ML_REPOSITORY_REFRESH_TIMEOUT_MS', legacyDelivery ?? 50_000, environment),
    repositoryIndexTimeoutMs: mlTimeoutMs('ML_REPOSITORY_INDEX_TIMEOUT_MS', 240_000, environment),
  };
}

export const FEED_REPAIR_ACK_MARGIN_MS = 1_000;

export function feedGenerationBudget(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const budget = {
    timeoutMs: mlTimeoutMs('FEED_GENERATION_TIMEOUT_MS', 60_000, environment),
    repairTimeoutMs: resolveMlTimeouts(environment).onboardingTimeoutMs,
  };
  if (budget.timeoutMs <= budget.repairTimeoutMs + FEED_REPAIR_ACK_MARGIN_MS) {
    throw new Error('FEED_GENERATION_TIMEOUT_MS must exceed ML_ONBOARDING_TIMEOUT_MS plus 1000ms '
      + '(onboarding may inherit ML_DELIVERY_TIMEOUT_MS). Increase the generation budget or lower the onboarding timeout.');
  }
  return budget;
}

export function getMlRuntimeConfig(): MlRuntimeConfig {
  const baseUrl = process.env.ML_SERVICE_URL?.replace(/\/+$/, '');
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!baseUrl) throw new Error('ML_SERVICE_URL is required for the v2 ML client.');
  if (!internalSecret) throw new Error('INTERNAL_API_SECRET is required for the v2 ML client.');
  return {
    baseUrl,
    internalSecret,
    ...resolveMlTimeouts(),
    maxResponseBytes: positiveInt('ML_MAX_RESPONSE_BYTES', 1_000_000),
  };
}
