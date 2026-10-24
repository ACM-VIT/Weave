import type { MlAppliedModelContext, MlModelRecommendationContext } from './ml.v2.js';
export interface FeedIntentScope {
 userId:string;feedVersion:string;profileVersion:string;acceptedOperationVersion:string;
 sessionId:string;epoch:string;epochStartedMs:string;witnessSha256:string;policySha256:string;
 queueScope:string;context:MlModelRecommendationContext;applied:MlAppliedModelContext;
}
