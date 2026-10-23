import type {
  MlRecommendationRequest,
  MlRecommendationResponse,
} from '../contracts/ml.v2.js';

export interface RecommendationPort {
  /** Local monotonic expiry shared across queueing, repair, and retries. */
  generate(input: MlRecommendationRequest, work?: { deadline: number }): Promise<MlRecommendationResponse>;
}
