export interface MlRuntimeConfig {
  baseUrl: string;
  internalSecret: string;
  timeoutMs: number;
  deliveryTimeoutMs?: number;
  repositoryIndexTimeoutMs?: number;
  maxResponseBytes: number;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function getMlRuntimeConfig(): MlRuntimeConfig {
  const baseUrl = process.env.ML_SERVICE_URL?.replace(/\/+$/, '');
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (!baseUrl) throw new Error('ML_SERVICE_URL is required for the v2 ML client.');
  if (!internalSecret) throw new Error('INTERNAL_API_SECRET is required for the v2 ML client.');
  return {
    baseUrl,
    internalSecret,
    timeoutMs: positiveInt('ML_TIMEOUT_MS', 5_000),
    deliveryTimeoutMs: positiveInt('ML_DELIVERY_TIMEOUT_MS', 30_000),
    repositoryIndexTimeoutMs: positiveInt('ML_REPOSITORY_INDEX_TIMEOUT_MS', 240_000),
    maxResponseBytes: positiveInt('ML_MAX_RESPONSE_BYTES', 1_000_000),
  };
}
