import type { MlRecommendationRequest, MlRecommendationResponse } from '../contracts/ml.v2.js';
import { ValidatedScoringGeneration } from './scoringCaptureValidation.js';

const ordinaryKeys = ['schema_version','generation_id','user_id','feed_version','model_version','embedding_version',
  'embedding_versions','served_ranker','heavy_ranker_selected','ranker_applied','fallback_code','fallback_reason',
  'retrieval_mode','context_status','items'];
const invalid = (): never => { throw new Error('SCORING_CAPTURE_INVALID'); };
const exact = (value: object, keys: string[]) => {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
};

/** Syntax is checked by JSON.parse first. This iterative pass retains object key
 * identity (including escaped keys) which JSON.parse intentionally discards. */
export function rejectDuplicateJsonKeys(text: string): void {
  const stack: Array<Set<string> | null> = [];
  for (let offset = 0; offset < text.length; offset++) {
    const token = text[offset];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === '"') {
      const start = offset;
      while (++offset < text.length) {
        if (text[offset] === '\\') offset++;
        else if (text[offset] === '"') break;
      }
      let next = offset + 1;
      while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        const keys = stack[stack.length - 1];
        if (!keys) return invalid();
        const key: string = JSON.parse(text.slice(start, offset + 1));
        if (keys.has(key)) invalid();
        keys.add(key);
      }
    }
  }
}

/** Called only after ordinary recommendation identity/provenance validation. */
export function validateCapturedRecommendation(value: MlRecommendationResponse, input: MlRecommendationRequest): ValidatedScoringGeneration | null {
  if (!input.scoring_capture) {
    if ('scoring_capture' in value || 'scoring_context' in value || 'scoring_metadata_complete' in value
      || value.items.some(item => 'scored_input' in item || 'raw_heavy_score' in item)) invalid();
    return null;
  }
  if (!('scoring_capture' in value) || !value.scoring_capture || typeof value.scoring_capture !== 'object'
    || !/^[1-9][0-9]{0,18}$/.test(String(value.feed_version)) || typeof value.feed_version !== 'string'
    || BigInt(value.feed_version) > 9223372036854775807n) return invalid();
  exact(value.scoring_capture, ['schema_version','status']);
  exact(value.context_status, ['cold_start_applied','locale']);
  if (value.scoring_capture.schema_version !== 1 || value.fallback_code !== null || value.fallback_reason !== null) invalid();
  if (value.scoring_capture.status === 'not_scored_empty') {
    exact(value, [...ordinaryKeys, 'scoring_capture']);
    if (value.items.length !== 0) invalid();
    return null;
  }
  if (value.scoring_capture.status !== 'captured' || !('scoring_context' in value)) return invalid();
  exact(value, [...ordinaryKeys, 'scoring_capture','scoring_context','scoring_metadata_complete']);
  if (value.served_ranker !== 'heavy' || !value.heavy_ranker_selected || !value.ranker_applied
    || !['personalized','cold_start_profile'].includes(value.retrieval_mode)
    || value.scoring_context.model_version !== value.model_version
    || value.scoring_metadata_complete !== (value.scoring_context.user_embedding_version !== null)) invalid();
  for (const item of value.items) {
    exact(item, ['repo_id','score','source','raw_heavy_score','scored_input',
      ...(item.retrieval_scores === undefined ? [] : ['retrieval_scores'])]);
    if (item.scored_input?.snapshot.repo_id !== item.repo_id) invalid();
  }
  const validated = ValidatedScoringGeneration.validate(value.scoring_context, value.items.map(item => ({
    packet: item.scored_input, rawHeavyScore: item.raw_heavy_score, finalScore: item.score,
    source: item.source, retrievalScores: item.retrieval_scores ?? {},
  })), { userId: input.user_id, generationId: input.generation_id, feedVersion: BigInt(value.feed_version) });
  const versions = [...new Set(value.items.map(item => value.scoring_context.repository_embedding_versions[
    item.scored_input.snapshot.embedding_version_index]))].sort();
  if (JSON.stringify(versions) !== JSON.stringify(value.embedding_versions)
    || value.embedding_version !== (versions.length === 1 ? versions[0] : 'compatible-mixed:' + versions.join(','))) invalid();
  return validated;
}
