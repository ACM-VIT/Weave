/** Allowlisted diagnostics; never copy arbitrary messages, URLs, SQL or response bodies. */
export function workerErrorSummary(error: unknown): Record<string, string | number> {
  if (!(error instanceof Error)) return { reason: 'non_error_thrown' };
  const details: Record<string, string | number> = {
    name: ['Error','TypeError','AbortError','TimeoutError','PostgresError','MlRecommendationError']
      .includes(error.name) ? error.name : 'Error',
  };
  const knownReasons: Record<string, string> = {
    'ML recommendation circuit is open.': 'ml_circuit_open',
    'ML returned unknown or inactive repositories.': 'invalid_repository_projection',
    'ML returned no active canonical repositories.': 'invalid_repository_projection',
    'fetch failed': 'transport_failed',
    'ML response exceeded size limit.': 'ml_response_too_large',
    'ML returned invalid JSON.': 'invalid_ml_json',
    'ML recommendation response violated the v2 envelope.': 'invalid_ml_envelope',
    'ML recommendation response contains an invalid or duplicate item.': 'invalid_ml_item',
  };
  if (Object.hasOwn(knownReasons, error.message)) details.reason = knownReasons[error.message];
  if ('code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(error.code)) {
    details.code = error.code;
  }
  if ('kind' in error && typeof error.kind === 'string'
    && ['dependency','contract','persona_unavailable','authentication','service_unavailable'].includes(error.kind)) details.kind = error.kind;
  if ('statusCode' in error && typeof error.statusCode === 'number'
    && Number.isInteger(error.statusCode) && error.statusCode >= 100 && error.statusCode <= 599) {
    details.status = error.statusCode;
  }
  if (error.cause instanceof Error && 'code' in error.cause && typeof error.cause.code === 'string'
    && /^[A-Z0-9_]{2,40}$/.test(error.cause.code)) {
    details.cause_code = error.cause.code;
  }
  return details;
}
