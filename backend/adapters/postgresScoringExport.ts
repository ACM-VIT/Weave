import crypto from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import {isDeepStrictEqual} from 'node:util';
import type { ScoringExportConfig } from '../config/scoringExport.js';
import { scoringExportPolicyDigest, scoringExportPolicyJson, validateScoringExportPolicy } from '../config/scoringExport.js';
import type { FrozenScoringExposure, ScoringExportManifest, ScoringExportPage, ScoringExportPolicy,
  ScoringExportPort, ScoringExportSelection } from '../contracts/scoringExport.js';
import { exportTimestampMicros, labelFrozenScoringExposure } from '../services/scoringExportLabels.js';

export class ScoringExportError extends Error {
  constructor(readonly reason: 'invalid'|'forbidden'|'expired'|'capacity'|'bounds'|'permission'|'unavailable') {
    super(`SCORING_EXPORT_${reason.toUpperCase()}`); this.name='ScoringExportError';
  }
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=/^[0-9a-f]{64}$/;
const invalid=():never=>{throw new ScoringExportError('invalid');};
const unavailable=():never=>{throw new ScoringExportError('unavailable');};
function object(value:unknown):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) return unavailable();
  return value as Record<string,unknown>;
}
function exact(value:Record<string,unknown>,keys:string[]):void {
  if (Object.keys(value).sort().join(',')!==keys.sort().join(',')) unavailable();
}
function id(value:unknown):value is string {return typeof value==='string' && uuid.test(value);}
function safeDatabaseError(error:unknown):ScoringExportError {
  if(error instanceof ScoringExportError) return error;
  if(error && typeof error==='object' && 'code' in error && 'message' in error) {
    const failures:Record<string,ScoringExportError['reason']>={SCORING_EXPORT_FORBIDDEN:'forbidden',SCORING_EXPORT_EXPIRED:'expired',
      SCORING_EXPORT_CAPACITY:'capacity',SCORING_EXPORT_BOUNDS:'bounds',SCORING_EXPORT_INVALID:'invalid'};
    if((error.code==='P0001'||error.code==='22023') && typeof error.message==='string' && failures[error.message])
      return new ScoringExportError(failures[error.message]);
  }
  // No DB error/cause, DETAIL, SQL parameters, event or packet representation.
  return new ScoringExportError('unavailable');
}

export function validateScoringExportSelection(value:ScoringExportSelection):void {
  if(!id(value.subjectUserId) || Object.keys(value).sort().join(',')!=='servedFrom,servedTo,subjectUserId') invalid();
  try {
    const from=exportTimestampMicros(value.servedFrom),to=exportTimestampMicros(value.servedTo);
    if(from>=to || to-from>31n*86400n*1_000_000n) invalid();
  } catch {invalid();}
}

/** New, dedicated pool only. No online ML SQL and no product-pool fallback. */
export class PostgresScoringExport implements ScoringExportPort {
  readonly #policyJson:string;
  readonly #digest:string;
  constructor(private readonly exporter:Sql,private readonly policy:Readonly<ScoringExportPolicy>) {
    this.#policyJson=scoringExportPolicyJson(policy); this.#digest=scoringExportPolicyDigest(policy);
  }
  private async verifyPermission():Promise<void> {
    const [role]=await this.exporter`
      SELECT pg_has_role(current_user,'ghsocial_scoring_exporter','MEMBER') AS exporter,
        pg_has_role(current_user,'ghsocial_scoring_writer','MEMBER') AS writer,
        pg_has_role(current_user,'ghsocial_scoring_retention','MEMBER') AS retention,
        pg_has_role(current_user,'ghsocial_backend','MEMBER') AS product,
        EXISTS(SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname IN ('app','telemetry') AND relation.relkind IN ('r','p','v','m','f')
            AND has_any_column_privilege(relation.oid,'SELECT')) AS product_reads,
        rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,
        has_any_column_privilege('private_scoring.scoring_inputs','SELECT') AS inputs,
        has_any_column_privilege('private_scoring.scoring_generations','SELECT') AS generations,
        has_any_column_privilege('private_scoring.export_snapshots','SELECT') AS snapshots,
        has_any_column_privilege('private_scoring.export_snapshot_labels','SELECT') AS labels,
        has_any_column_privilege('private_scoring.generation_witnesses','SELECT') AS witnesses,
        has_any_column_privilege('private_scoring.export_authorizations','SELECT') AS authorizations,
        has_table_privilege('private_scoring.export_authorizations','INSERT,UPDATE,DELETE') AS grants
      FROM pg_roles WHERE rolname=current_user`;
    if(!role?.exporter || role.writer || role.retention || role.product || role.product_reads || role.rolsuper || role.rolcreaterole || role.rolcreatedb
      || role.rolreplication || role.rolbypassrls || role.inputs || role.generations || role.snapshots || role.labels || role.witnesses || role.authorizations || role.grants)
      throw new ScoringExportError('permission');
  }
  private manifest(value:unknown,principal:string):ScoringExportManifest {
    const row=object(value);
    exact(row,['job_id','principal_id','subject_user_id','observed_at','pg_snapshot','expires_at','served_from','served_to','policy','row_count','event_count']);
    if(!id(row.job_id)||row.principal_id!==principal||!id(row.subject_user_id)||typeof row.pg_snapshot!=='string'
      || !/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/.test(row.pg_snapshot)
      || !Number.isInteger(row.row_count)||Number(row.row_count)<0||Number(row.row_count)>500
      || !Number.isInteger(row.event_count)||Number(row.event_count)<0||Number(row.event_count)>5000) unavailable();
    try {
      validateScoringExportPolicy(row.policy as ScoringExportPolicy);
      if(scoringExportPolicyDigest(row.policy as ScoringExportPolicy)!==this.#digest) unavailable();
      const observed=exportTimestampMicros(row.observed_at as string),expires=exportTimestampMicros(row.expires_at as string);
      validateScoringExportSelection({subjectUserId:row.subject_user_id as string,servedFrom:row.served_from as string,servedTo:row.served_to as string});
      if(expires<=observed || expires-observed>BigInt(this.policy.snapshotTtlSeconds)*1_000_000n) unavailable();
    } catch {unavailable();}
    return row as unknown as ScoringExportManifest;
  }
  async create(principalId:string,selection:ScoringExportSelection):Promise<ScoringExportManifest> {
    if(!id(principalId)) invalid(); validateScoringExportSelection(selection);
    try {
      await this.verifyPermission();
      // SQL's subject fence turns stale RR revocation visibility into 40001.
      // Retry a whole fresh transaction once; never retry partial materialization.
      for(let attempt=0;attempt<2;attempt++) {
        try {
          const result=await this.exporter.begin('isolation level repeatable read',async transaction=>{
            const [row]=await transaction`SELECT private_scoring.create_export_snapshot(${principalId}::uuid,${selection.subjectUserId}::uuid,
              ${selection.servedFrom}::timestamptz,${selection.servedTo}::timestamptz,${this.#policyJson}::text) AS result`;
            const candidate=object(row?.result);exact(candidate,['manifest','frozen_rows']);
            const manifest=this.manifest(candidate.manifest,principalId);
            if(!Array.isArray(candidate.frozen_rows)||candidate.frozen_rows.length!==manifest.row_count)unavailable();
            const labels=(candidate.frozen_rows as FrozenScoringExposure[]).map(exposure=>{
              const {raw_events:_,...metadata}=labelFrozenScoringExposure(exposure,manifest.observed_at,manifest.policy);return metadata;
            });
            const [sealed]=await transaction`SELECT private_scoring.seal_export_labels(${principalId}::uuid,${manifest.job_id}::uuid,
              ${this.#digest}::text,${JSON.stringify(labels)}::text) AS result`;
            const sealedManifest=this.manifest(sealed?.result,principalId);
            if(!isDeepStrictEqual(sealedManifest,manifest))unavailable();
            return sealedManifest;
          });
          return result as ScoringExportManifest;
        } catch(error) {
          if(attempt===0&&error&&typeof error==='object'&&'code' in error&&error.code==='40001') continue;
          throw error;
        }
      }
      return unavailable();
    } catch(error) {throw safeDatabaseError(error);}
  }
  async page(principalId:string,jobId:string,after:number,limit:number):Promise<ScoringExportPage> {
    if(!id(principalId)||!id(jobId)||!Number.isInteger(after)||after<0||after>500||!Number.isInteger(limit)||limit<1||limit>100) invalid();
    try {
      await this.verifyPermission();
      const [row]=await this.exporter`SELECT private_scoring.read_export_snapshot(${principalId}::uuid,${jobId}::uuid,
        ${this.#digest}::text,${after}::integer,${limit}::integer) AS result`;
      const value=object(row?.result); exact(value,['manifest','rows']);
      const manifest=this.manifest(value.manifest,principalId);
      if(manifest.job_id!==jobId||!Array.isArray(value.rows)||value.rows.length>limit) unavailable();
      const rows:ScoringExportPage['rows'][number][]=[];
      for(const candidate of value.rows as unknown[]) {
        const item=object(candidate); exact(item,['ordinal','exposure','input','labels']);
        if(item.ordinal!==after+rows.length+1 || Number(item.ordinal)>manifest.row_count) unavailable();
        const exposure=object(item.exposure);
        exact(exposure,['user_id','serve_id','repo_id','position','session_id','exposure_id','served_at','generation_id','legacy_generation_hint','record_digest','source_status','source_expires_at','events']);
        if(exposure.user_id!==manifest.subject_user_id||!(exposure.exposure_id===null||id(exposure.exposure_id))
          || !(exposure.generation_id===null||id(exposure.generation_id))
          || !(exposure.legacy_generation_hint===null||id(exposure.legacy_generation_hint))
          || (exposure.source_status==='captured'&&exposure.legacy_generation_hint!==null)
          || !(exposure.record_digest===null||(typeof exposure.record_digest==='string'&&hash.test(exposure.record_digest)))
          || !['captured','not_captured','legacy_unknown','provenance_unavailable'].includes(exposure.source_status as string)) unavailable();
        const typed=exposure as unknown as FrozenScoringExposure;
        const labels=labelFrozenScoringExposure(typed,manifest.observed_at,manifest.policy);
        const {raw_events:_,...metadata}=labels;
        if(!isDeepStrictEqual(metadata,item.labels))unavailable();
        let input:ScoringExportPage['rows'][number]['input']=null;
        if(exposure.source_status==='captured') {
          const packet=object(item.input); exact(packet,['context_json','context_digest','snapshot_json','input_base64','binding_sha256','stage_json','record_digest']);
          if(!Object.values(packet).every(value=>typeof value==='string')) unavailable();
          input=packet as unknown as NonNullable<ScoringExportPage['rows'][number]['input']>;
          if(Buffer.byteLength(input.context_json)>16384||Buffer.byteLength(input.snapshot_json)>4096||Buffer.byteLength(input.stage_json)>8192
            ||input.input_base64.length!==4152||!/^[A-Za-z0-9+/]+==$/.test(input.input_base64)) unavailable();
          const bytes=Buffer.from(input.input_base64,'base64');
          const digest=(value:crypto.BinaryLike)=>crypto.createHash('sha256').update(value).digest('hex');
          if(bytes.length!==3112||bytes.toString('base64')!==input.input_base64||input.record_digest!==exposure.record_digest
            ||digest(input.context_json)!==input.context_digest
            ||digest(Buffer.concat([Buffer.from(input.context_json),Buffer.from(input.snapshot_json),bytes,Buffer.from(input.stage_json)]))!==input.record_digest
            ||digest(Buffer.concat([Buffer.from('{"context":'+input.context_json+',"snapshot":'+input.snapshot_json+'}'),bytes]))!==input.binding_sha256) unavailable();
        } else if(item.input!==null) unavailable();
        rows.push({ordinal:Number(item.ordinal),exposure:typed,labels,input});
      }
      if(!rows.length && after<manifest.row_count) unavailable();
      // Include complete rows until the wire bound. Never truncate one event list.
      while(rows.length && Buffer.byteLength(JSON.stringify({manifest,rows,next_after:rows.at(-1)!.ordinal<manifest.row_count?rows.at(-1)!.ordinal:null}))>1_000_000) rows.pop();
      if(!rows.length && after<manifest.row_count) throw new ScoringExportError('bounds');
      const last=rows.at(-1)?.ordinal??after;
      if(exportTimestampMicros(new Date().toISOString())>=exportTimestampMicros(manifest.expires_at))throw new ScoringExportError('expired');
      return {manifest,rows,next_after:last<manifest.row_count?last:null};
    } catch(error) {throw safeDatabaseError(error);}
  }
  async revoke(principalId:string,subjectUserId:string):Promise<{revoked:true;purge_pending:true}> {
    if(!id(principalId)||!id(subjectUserId)) invalid();
    try {
      await this.verifyPermission();
      const [row]=await this.exporter`SELECT private_scoring.revoke_subject_capture(${principalId}::uuid,${subjectUserId}::uuid,${this.#digest}::text) AS result`;
      const value=object(row?.result); exact(value,['revoked','purge_pending']);
      if(value.revoked!==true||value.purge_pending!==true) unavailable();
      return {revoked:true,purge_pending:true};
    } catch(error){throw safeDatabaseError(error);}
  }
}

export function createPrivateScoringExport(config:ScoringExportConfig):{port:ScoringExportPort;close():Promise<void>}|null {
  if(!config.enabled) return null;
  const exporter=postgres(config.exporterDatabaseUrl,{max:2,prepare:false,connect_timeout:2,idle_timeout:20,onnotice:()=>undefined,
    connection:{statement_timeout:config.statementTimeoutMs,lock_timeout:Math.min(config.statementTimeoutMs,1000)}});
  return {port:new PostgresScoringExport(exporter,config.policy),close:()=>exporter.end({timeout:1})};
}
