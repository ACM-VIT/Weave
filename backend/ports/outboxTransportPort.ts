import type { MlModelOperationBatch, MlModelOperationResponse, MlProfileWithdrawalBatch, MlProfileWithdrawalResponse } from '../contracts/ml.v2.js';
import type {
  DeliveryResult,
  MlFeedbackBatch,
  MlOnboardingJob,
  MlRepositoryIndexJob,
  MlRepositoryRefreshJob,
} from '../contracts/ml.v2.js';

export interface OutboxTransportPort {
  deliverModelOperations?(batch:MlModelOperationBatch):Promise<DeliveryResult<MlModelOperationResponse>>;
  deliverProfileWithdrawals?(batch:MlProfileWithdrawalBatch):Promise<DeliveryResult<MlProfileWithdrawalResponse>>;
  deliverFeedback(batch: MlFeedbackBatch): Promise<DeliveryResult>;
  deliverOnboarding(job: MlOnboardingJob): Promise<DeliveryResult>;
  deliverRepositoryIndex(job: MlRepositoryIndexJob): Promise<DeliveryResult>;
  deliverRepositoryRefresh(job: MlRepositoryRefreshJob): Promise<DeliveryResult>;
}
