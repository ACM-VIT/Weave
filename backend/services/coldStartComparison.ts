import { createHash } from 'node:crypto';
import { exportColdStartContexts, type ColdStartContextInput } from './coldStartContextExport.js';
import { isValidUuid } from '../utils/validators.js';
const stages = ['retrieval', 'ranking', 'assembly'] as const;
const variants = ['onboarding_only', 'github_only', 'combined'] as const;
type Row = Record<string, unknown>;
function invalid(): never {
  throw new Error('Invalid or incomparable cold-start model evidence.');
}
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Row;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return invalid();
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  if (typeof value === 'number' && !Number.isFinite(value))
    return invalid();
  const result = JSON.stringify(value);
  return result === undefined ? invalid() : result;
}
function invariantConfiguration(value: unknown): Row {
  const configuration = structuredClone(object(value));
  if (configuration.runtime !== undefined) {
    const runtime = object(configuration.runtime);
    // These two fields are measured observations captured after the run. Keep
    // executor admission settings in the comparison; retain observations raw.
    delete runtime.shape_calls_by_profile;
    if (runtime.retrieval_executor !== undefined) {
      const executor = object(runtime.retrieval_executor);
      if (!Number.isInteger(executor.workers) || Number(executor.workers) < 1
        || !Number.isInteger(executor.capacity) || Number(executor.capacity) < 1)
        return invalid();
      runtime.retrieval_executor = { workers: executor.workers, capacity: executor.capacity };
    }
  }
  return configuration;
}
/** Compare supplied actual ML-owned stage exports. This offline reader performs
* no model/database/network writes and makes no real-user quality claim. */
export function compareColdStartRuns(input: ColdStartContextInput, evidence: unknown, k = 5) {
  if (!Number.isInteger(k) || k < 1 || k > 100)
    return invalid();
  const contexts = exportColdStartContexts(input), measured = object(evidence);
  if (contexts.variants.some(row => !row.has_embedding_context) || measured.schema_version !== 1
    || !Array.isArray(measured.conditions) || measured.conditions.length !== 3 || !Array.isArray(measured.corpus_repo_ids)
    || !measured.corpus_repo_ids.length || measured.corpus_repo_ids.length > 256
    || measured.corpus_repo_ids.some(id => typeof id !== 'string' || !isValidUuid(id))
    || new Set(measured.corpus_repo_ids).size !== measured.corpus_repo_ids.length)
    return invalid();
  const conditions = measured.conditions, corpusHash = hash(measured.corpus_sha256), corpus = new Set(measured.corpus_repo_ids as string[]);
  const encoder = object(measured.encoder);
  if (encoder.model !== 'all-MiniLM-L6-v2' || encoder.revision !== 'c9745ed1d9f207416be6d2e6f8de32d1f16199bf' || encoder.dimension !== 384)
    return invalid();
  let commonIdentity: string | undefined;
  const results = contexts.variants.map(context => {
    const matches = conditions.filter(value => object(value).variant === context.variant);
    if (matches.length !== 1)
      return invalid();
    const condition = object(matches[0]);
    if (condition.context_sha256 !== context.context_sha256 || condition.corpus_sha256 !== corpusHash)
      return invalid();
    hash(condition.synthesized_context_sha256);
    hash(condition.profile_vector_sha256);
    const execution = object(condition.execution), run = object(execution.run), artifacts = object(execution.artifacts), source = object(execution.source_sha256);
    for (const key of ['model_sha256', 'scaler_sha256', 'manifest_sha256']) {
      hash(artifacts[key]);
      if (run[key] !== artifacts[key])
        return invalid();
    }
    if (!Object.keys(source).length || Object.keys(source).length > 500)
      return invalid();
    Object.values(source).forEach(hash);
    if (execution.format !== 'frozen-model-stages-v1' || execution.execution_scope !== 'offline-local-qdrant-exact-cpu'
      || typeof execution.code_commit !== 'string' || !/^[a-f0-9]{40}$/.test(execution.code_commit) || run.code_commit !== execution.code_commit
      || typeof execution.source_tree_dirty !== 'boolean' || run.timing_kind !== 'measured' || typeof execution.as_of !== 'string'
      || !Number.isFinite(Date.parse(execution.as_of)) || Date.parse(execution.as_of) < Date.parse(input.cutoff)
      || typeof execution.seed !== 'string' || !execution.seed.length || !Array.isArray(run.outputs) || run.outputs.length !== 1)
      return invalid();
    const identity = canonical({ artifacts, source, code_commit: execution.code_commit, dirty: execution.source_tree_dirty,
      as_of: execution.as_of, seed: execution.seed, configuration: invariantConfiguration(execution.configuration), libraries: execution.libraries });
    if (commonIdentity !== undefined && identity !== commonIdentity)
      return invalid();
    commonIdentity = identity;
    hash(execution.snapshot_sha256);
    hash(execution.bundle_sha256);
    const output = object(run.outputs[0]), outputs = object(output.stages), timings = object(output.latency_ms);
    if (output.profile_id !== input.profile_id || Object.keys(outputs).sort().join(',') !== 'assembly,ranking,retrieval')
      return invalid();
    const ranked = Object.fromEntries(stages.map(stage => {
      const values = outputs[stage];
      if (!Array.isArray(values) || values.length > 256 || typeof timings[stage] !== 'number' || !Number.isFinite(timings[stage]) || Number(timings[stage]) < 0)
        return invalid();
      const rows = values.map(value => {
        const row = object(value);
        if (typeof row.repo_id !== 'string' || !corpus.has(row.repo_id)
          || typeof row.score !== 'number' || !Number.isFinite(row.score) || typeof row.source !== 'string' || !row.source)
          return invalid();
        return { repo_id: row.repo_id, score: row.score, source: row.source };
      });
      if (new Set(rows.map(row => row.repo_id)).size !== rows.length)
        return invalid();
      return [stage, rows.slice(0, k)] as const;
    }));
    return { variant: context.variant, context_sha256: context.context_sha256, provenance: context.provenance,
      synthesized_context_sha256: condition.synthesized_context_sha256, profile_vector_sha256: condition.profile_vector_sha256,
      ranked, latency_ms: timings, execution };
  });
  const pairwise = variants.flatMap((left, index) => variants.slice(index + 1).map(right => ({ left, right, stages: Object.fromEntries(stages.map(stage => {
      const a = results.find(row => row.variant === left)!.ranked[stage], b = results.find(row => row.variant === right)!.ranked[stage];
      const common = a.filter(row => b.some(other => other.repo_id === row.repo_id)).length, union = new Set([...a, ...b].map(row => row.repo_id)).size;
      return [stage, { shared_top_k: common, union_top_k: union, jaccard: union ? common / union : null,
          same_rank_positions: a.filter((row, index) => b[index]?.repo_id === row.repo_id).length }];
    })) })));
  return { schema_version: 1, purpose: 'cold_start_three_condition_comparison', source_kind: input.source_kind,
    input_sha256: createHash('sha256').update(canonical(input)).digest('hex'), corpus_sha256: corpusHash, encoder, k, results, pairwise,
    production_qualified: false, evidence_limit: 'Measured frozen-corpus diagnostic. Synthetic fixture contexts/labels are not real-user relevance or production quality evidence.' };
}
