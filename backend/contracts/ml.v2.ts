import type { components, paths } from './ml-v2.generated.js';

type Schemas = components['schemas'];
export type MlPostPath = keyof paths;
export type MlRequest<Path extends MlPostPath> = paths[Path]['post']['requestBody']['content']['application/json'];
export type MlDeliveryPath = Exclude<MlPostPath, '/api/v2/recommendations/generate' | '/api/v2/search/repositories'>;

export const ML_SCHEMA_VERSION = 2 as const;
export const ML_DESCRIPTION_FALLBACK_MODEL_VERSION = 'repository-description-fallback-v1' as const;

export type MlRecommendationRequest = Schemas['RecommendationRequest'] & { exclude_repo_ids: string[] };
export type MlRecommendationItem = Schemas['RecommendationItem'];
export type MlRecommendationResponse = Schemas['RecommendationResponse'] | Schemas['ModelRecommendationResponse'] | Schemas['CapturedRecommendationResponse'] | Schemas['UnscoredEmptyRecommendationResponse'];
// The persisted decimal version is kept exact across JS and Python. Both wire
// representations are accepted by the generated provider schema.
export type MlFeedbackEvent = Omit<Schemas['FeedbackEvent'], 'feedback_version'> & { feedback_version: string };
export type MlFeedbackBatch = Omit<Schemas['FeedbackBatch'], 'events'> & { events: MlFeedbackEvent[] };
export type MlOnboardingJob = Omit<Schemas['OnboardingJob'], 'schema_version'>;
// url is the existing accepted validation alias; new clients use html_url.
export type MlRepositorySource = Schemas['RepositorySource'] & { url?: Schemas['RepositorySource']['html_url'] };
export type MlRepositoryIndexJob = Omit<Schemas['RepositoryJob'], 'schema_version' | 'repository'> & { repository: MlRepositorySource };
export type MlRepositoryIndexStatus = Schemas['RepositoryIndexResponse']['status'];
export type MlRepositoryCardSummary = Schemas['CardSummaryArtifact'];
export type MlRepositoryIndexResponse = Schemas['RepositoryIndexResponse'];
export type MlRepositoryFeaturePatch = Schemas['RepositoryFeaturePatch'];
export type MlRepositoryRefreshJob = Omit<Schemas['RepositoryRefreshJob'], 'schema_version'>;

export interface DeliveryResult<ResponseBody = unknown> {
  /** Transport-only classification; never changes retry or acceptance policy. */
  failure_kind?: 'timeout';
  accepted: boolean;
  retryable: boolean;
  status_code: number;
  detail?: string;
  retry_after_ms?: number;
  response_body?: ResponseBody;
}

export type MlModelOperationBatch = Schemas['ModelOperationBatch'];
export type MlModelOperationResponse = Schemas['ModelOperationResponse'];
export type MlProfileWithdrawalBatch = Schemas['ProfileWithdrawalBatch'];
export type MlProfileWithdrawalResponse = Schemas['ProfileWithdrawalResponse'];
export type MlModelOperationStatusRequest = Schemas['ModelOperationStatusRequest'];
export type MlModelOperationStatusResponse = Schemas['ModelOperationStatusResponse'];
export type MlModelAuthorityRequest = Schemas['ModelAuthorityRequest'];
export type MlModelAuthorityResponse = Schemas['ModelAuthorityResponse'];
export type MlModelRecommendationContext = Schemas['ModelRecommendationContext'];
export type MlAppliedModelContext = Schemas['AppliedModelContext'];
