import { isDeepStrictEqual } from 'node:util';
import { LANGUAGE_OBSERVATION_FIELDS, hasLanguageObservation, type RepositoryLanguageObservation } from './repositoryLanguages.js';
/** Observed GitHub ancestry only; mutable names never establish a fork family. */
export interface RepositoryLineage {
  is_fork?: boolean | null;
  fork_parent_github_id?: string | null;
  fork_family_github_id?: string | null;
  lineage_observed_at?: string | null;
  lineage_source?: 'github-graphql-repository' | 'github-rest-repository' | null;
}
export const LINEAGE_FIELDS = ['is_fork','fork_parent_github_id','fork_family_github_id','lineage_observed_at','lineage_source'] as const;

export function canonicalGithubRepositoryId(value: unknown): string {
  if(typeof value!=='string'|| !/^[0-9]{1,32}$/.test(value))throw new Error('GitHub identity requires decimal text.');
  const id=BigInt(value);
  if(id<=0n||id>2n**63n-1n)throw new Error('GitHub identity exceeds positive signed-bigint bounds.');
  return id.toString();
}

/** Return an exact sortable microsecond key; never infer UTC from a naive time. */
function observation(value: unknown): bigint {
  if(typeof value!=='string')throw new Error('Lineage requires an explicit UTC observation.');
  const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(value);
  const ms=match?Date.parse(match[1]+'Z'):NaN;
  if(!match||!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,19)!==match[1])throw new Error('Lineage requires a valid UTC observation.');
  return BigInt(ms)*1000n+BigInt((match[2]??'').padEnd(6,'0'));
}

export function validateRepositoryLineage(value: RepositoryLineage, githubId: string): void {
  if(value.is_fork!==undefined&&value.is_fork!==null&&typeof value.is_fork!=='boolean')throw new Error('Fork state must be boolean or unknown.');
  const parent=value.fork_parent_github_id,family=value.fork_family_github_id;
  for(const id of [parent,family])if(id!=null&&canonicalGithubRepositoryId(id)!==id)throw new Error('Ancestry requires canonical decimal identities.');
  if(value.is_fork==null&&(parent!=null||family!=null))throw new Error('Ancestry requires explicit fork state.');
  if(value.is_fork===false&&(parent!=null||(family!=null&&family!==canonicalGithubRepositoryId(githubId))))throw new Error('Nonfork ancestry contradicts repository identity.');
  if(value.is_fork===true&&[parent,family].includes(canonicalGithubRepositoryId(githubId)))throw new Error('Fork ancestry cannot reference itself.');
  const source=value.lineage_source,time=value.lineage_observed_at;
  if((source==null)!==(time==null))throw new Error('Lineage source and time must be supplied together.');
  if(value.is_fork!=null&&source==null)throw new Error('Known fork state requires observed provenance.');
  if(source!=null){
    if(!['github-graphql-repository','github-rest-repository'].includes(source))throw new Error('Unknown lineage source.');
    observation(time);
  }
}

/** Missing observation preserves known state; old/equal conflicting work cannot replace it. */
export function mergeRepositoryLineage(incoming: RepositoryLineage, stored: RepositoryLineage, githubId: string): RepositoryLineage {
  validateRepositoryLineage(incoming,githubId);validateRepositoryLineage(stored,githubId);
  const selected=(value:RepositoryLineage):RepositoryLineage=>Object.fromEntries(LINEAGE_FIELDS.map(key=>[key,value[key]??null]));
  if(incoming.lineage_observed_at==null)return selected(stored);
  if(stored.lineage_observed_at!=null){
    const delta=observation(incoming.lineage_observed_at)-observation(stored.lineage_observed_at);
    if(delta<0n)return selected(stored);
    if(delta===0n){
      if(LINEAGE_FIELDS.filter(key=>key!=='lineage_observed_at').some(key=>(incoming[key]??null)!==(stored[key]??null)))throw new Error('Conflicting lineage observations share the same timestamp.');
      return selected(stored);
    }
  }
  return selected(incoming);
}

export { observation as repositoryObservationMicros };

/** Rich observations have their own clock; name-only and older inputs cannot erase them. */
export function mergeRepositoryLanguageObservation(
  incoming: RepositoryLanguageObservation & {observed_at: string},
  stored: RepositoryLanguageObservation & {language_observed_at?: string | null},
): RepositoryLanguageObservation & {language_observed_at: string | null} {
  const selected = (value: RepositoryLanguageObservation, time: string | null) => ({
    ...Object.fromEntries(LANGUAGE_OBSERVATION_FIELDS.map(key => [key,value[key] ?? null])), language_observed_at:time,
  });
  if (!hasLanguageObservation(incoming)) return selected(stored,stored.language_observed_at ?? null);
  const next = observation(incoming.observed_at);
  if (stored.language_observed_at != null) {
    const difference = next - observation(stored.language_observed_at);
    if (difference < 0n) return selected(stored,stored.language_observed_at);
    if (difference === 0n) {
      if (!isDeepStrictEqual(selected(incoming,null), selected(stored,null))) throw new Error('Conflicting language observations share a timestamp.');
      return selected(stored,stored.language_observed_at);
    }
  }
  return selected(incoming,incoming.observed_at);
}
