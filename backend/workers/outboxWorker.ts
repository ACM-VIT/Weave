import { modelDigest } from '../contracts/modelOperations.js';
import { startSpan, httpOutcome, withoutOutboxTrace } from '../observability/tracing.js';
import { observeStage, type StageOutcome } from '../observability/metrics.js';
import type {
  DeliveryResult,
  MlFeedbackBatch,
  MlOnboardingJob,
  MlRepositoryIndexJob,
  MlRepositoryRefreshJob,
} from '../contracts/ml.v2.js';
import type { OutboxTransportPort } from '../ports/outboxTransportPort.js';
import {
  OutboxService,
  RepositoryIndexCompletionConflictError,
  type OutboxRow,
} from '../services/outboxService.js';
import {
  MlRepositoryIndexContractError,
  parseMlRepositoryIndexResponse,
} from '../services/mlService.js';

export class OutboxWorker {
  constructor(
    private readonly outbox: OutboxService,
    private readonly transport: OutboxTransportPort,
  ) {}

  private deliver(row: OutboxRow) {
    const payload = withoutOutboxTrace(row.payload);
    if (row.job_type === 'feedback') {
      return this.transport.deliverFeedback({ schema_version: 2, events: [payload as unknown as MlFeedbackBatch['events'][number]] });
    }
    if (row.job_type === 'onboard') return this.transport.deliverOnboarding(payload as unknown as MlOnboardingJob);
    if (row.job_type === 'repo_index') return this.transport.deliverRepositoryIndex(payload as unknown as MlRepositoryIndexJob);
    // Internal outbox dependency metadata is not part of the strict ML DTO.
    const { job_id, repo_id, feature_version, features } = payload as unknown as MlRepositoryRefreshJob;
    return this.transport.deliverRepositoryRefresh({ job_id, repo_id, feature_version, features });
  }

  private async deliverModel(row:OutboxRow):Promise<DeliveryResult>{
    const current=await this.outbox.prepareModelDelivery(row);
    if(!current)return {accepted:false,retryable:true,status_code:0,detail:'Model delivery claim is no longer current.'};
    if(!current.operation_json || modelDigest(current.operation_json)!==current.source_envelope_sha256 || !current.model_operation_version){
      await this.outbox.markFailed(current,'Invalid frozen model source.',false);
      return {accepted:false,retryable:false,status_code:0,detail:'Invalid frozen model source.'};
    }
    let result:DeliveryResult;
    let acknowledged=false;
    if(current.withdrawal_json){
      if(!this.transport.deliverProfileWithdrawals)result={accepted:false,retryable:true,status_code:503};
      else{
        const response=await this.transport.deliverProfileWithdrawals({schema_version:1,withdrawals:[{withdrawal_json:current.withdrawal_json}]});
        result=response;
        const a=response.response_body?.withdrawals;
        acknowledged=response.accepted && a?.length===1 && a[0].operation_id===current.outbox_id
          && a[0].model_operation_version===current.model_operation_version && a[0].source_envelope_sha256===current.source_envelope_sha256
          && a[0].withdrawal_sha256===modelDigest(current.withdrawal_json) && ['accepted','duplicate'].includes(a[0].status);
      }
    }else{
      if(!this.transport.deliverModelOperations)result={accepted:false,retryable:true,status_code:503};
      else{
        const response=await this.transport.deliverModelOperations({schema_version:1,operations:[{operation_json:current.operation_json}]});
        result=response;
        const a=response.response_body?.operations;
        // withdrawal_accepted requires reloading the attestation, never claims original application.
        acknowledged=response.accepted && a?.length===1 && a[0].operation_id===current.outbox_id
          && a[0].model_operation_version===current.model_operation_version && a[0].source_envelope_sha256===current.source_envelope_sha256
          && ['accepted','duplicate'].includes(a[0].status);
      }
    }
    if(acknowledged)await this.outbox.markDelivered(current);
    else await this.outbox.markFailed(current,'Model delivery was not durably acknowledged.',result.accepted||result.retryable,result.retry_after_ms);
    return {...result,accepted:acknowledged,detail:acknowledged?undefined:'Model delivery was not durably acknowledged.'};
  }

  async runOnce(limit = 1): Promise<number> {
    let processed = 0;
    for (let index = 0; index < limit; index++) {
      // Claim immediately before delivery so rows never wait behind an older
      // sequential request while their database lease is already ticking.
      const [row] = await this.outbox.claim(1);
      if (!row) break;
      await this.deliverClaimed(row);
      processed++;
    }
    return processed;
  }

  /** A caller must already own immediate transport capacity for this claim. */
  async deliverClaimed(row: OutboxRow): Promise<DeliveryResult> {
    if(row.job_type==='model_operation')return this.deliverModel(row);
    if (row.job_type === 'onboard' && !await this.outbox.prepareOnboardingDelivery(row)) {
      return { accepted: false, retryable: false, status_code: 0, detail: 'Onboarding context is no longer current.' };
    }
    // Each attempt is a distinct child of the durable enqueue context.
    const span = startSpan(row.job_type, 'outbox_delivery', true, row.payload._traceparent);
    observeStage(row.job_type, 'outbox_age', 'success', Date.now() - Date.parse(row.created_at));
    let outcome: StageOutcome = 'failure';
    const result = await span.run(async () => {
      try {
        const delivery = await this.deliver(row);
        outcome = delivery.accepted ? 'success' : delivery.failure_kind === 'timeout' ? 'timeout'
          : delivery.status_code >= 400 ? httpOutcome(delivery.status_code) : 'failure';
        return delivery;
      } finally { span.finish(outcome); }
    });
    if (result.accepted) {
      if (row.job_type === 'repo_index') {
        if (!result.response_body) {
          await this.outbox.markFailed(
            row,
            'ML accepted repository index without a versioned card-summary response.',
            true,
          );
        } else {
          try {
            const job = row.payload as unknown as MlRepositoryIndexJob;
            await this.outbox.completeRepositoryIndex(
              row,
              parseMlRepositoryIndexResponse(result.response_body, job),
            );
          } catch (error) {
            if (error instanceof MlRepositoryIndexContractError
              || error instanceof RepositoryIndexCompletionConflictError) {
              await this.outbox.markFailed(row, error.message, false);
            } else {
              // Unknown database/process failures retain the claim so the
              // lease can recover atomic completion after a crash.
              throw error;
            }
          }
        }
      } else {
        await this.outbox.markDelivered(row);
      }
    }
    else await this.outbox.markFailed(
      row, result.detail ?? `status ${result.status_code}`, result.retryable, result.retry_after_ms,
    );
    return result;
  }
}
