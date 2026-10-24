import postgres,{type Sql} from 'postgres';

export class ScoringRetentionError extends Error {
  constructor(){super('SCORING_RETENTION_UNAVAILABLE');this.name='ScoringRetentionError';}
}
export type ScoringRetentionConfig={enabled:false}|{enabled:true;databaseUrl:string;statementTimeoutMs:number;batchSize:number};
/** Explicit operational configuration; no chosen production policy or schedule. */
export function getScoringRetentionConfig(environment:Readonly<Record<string,string|undefined>>=process.env):ScoringRetentionConfig {
  if(environment.SCORING_RETENTION_ENABLED===undefined||environment.SCORING_RETENTION_ENABLED===''||environment.SCORING_RETENTION_ENABLED==='false')return{enabled:false};
  try {
    if(environment.SCORING_RETENTION_ENABLED!=='true')throw new Error();
    const databaseUrl=environment.SCORING_RETENTION_DATABASE_URL??'',uri=new URL(databaseUrl);
    const rawTimeout=environment.SCORING_RETENTION_STATEMENT_TIMEOUT_MS??'',rawBatch=environment.SCORING_RETENTION_BATCH_SIZE??'';
    const statementTimeoutMs=Number(rawTimeout),batchSize=Number(rawBatch);
    if(!['postgres:','postgresql:'].includes(uri.protocol)||!uri.username
      ||[environment.DATABASE_URL,environment.SCORING_CAPTURE_DATABASE_URL,environment.SCORING_EXPORT_DATABASE_URL].includes(databaseUrl)
      ||!/^[1-9][0-9]{0,4}$/.test(rawTimeout)||statementTimeoutMs<100||statementTimeoutMs>10000
      ||!/^[1-9][0-9]{0,2}$/.test(rawBatch)||batchSize>100)throw new Error();
    return{enabled:true,databaseUrl,statementTimeoutMs,batchSize};
  }catch{throw new ScoringRetentionError();}
}
export class PostgresScoringRetention {
  constructor(private readonly retention:Sql,private readonly batchSize:number){
    if(!Number.isInteger(batchSize)||batchSize<1||batchSize>100)throw new ScoringRetentionError();
  }
  async purgeOnce():Promise<{generationsDeleted:number;snapshotsDeleted:number}>{
    try {
      const [role]=await this.retention`SELECT pg_has_role(current_user,'ghsocial_scoring_retention','MEMBER') AS retention,
        pg_has_role(current_user,'ghsocial_scoring_writer','MEMBER') AS writer,
        pg_has_role(current_user,'ghsocial_scoring_exporter','MEMBER') AS exporter,
        pg_has_role(current_user,'ghsocial_backend','MEMBER') AS product,
        EXISTS(SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname IN ('app','telemetry') AND relation.relkind IN ('r','p','v','m','f')
            AND has_any_column_privilege(relation.oid,'SELECT')) AS product_reads,
        rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,
        has_any_column_privilege('private_scoring.scoring_inputs','SELECT') AS inputs,
        has_any_column_privilege('private_scoring.scoring_generations','SELECT') AS generations,
        has_any_column_privilege('private_scoring.generation_witnesses','SELECT') AS witnesses,
        has_any_column_privilege('private_scoring.export_authorizations','SELECT') AS authorizations,
        has_table_privilege('private_scoring.export_authorizations','INSERT,UPDATE,DELETE') AS grants,
        has_any_column_privilege('private_scoring.export_snapshots','SELECT') AS snapshots
        ,has_any_column_privilege('private_scoring.export_snapshot_labels','SELECT') AS labels
        FROM pg_roles WHERE rolname=current_user`;
      if(!role?.retention||role.writer||role.exporter||role.product||role.product_reads||role.rolsuper||role.rolcreaterole||role.rolcreatedb||role.rolreplication||role.rolbypassrls||role.inputs||role.generations||role.witnesses||role.authorizations||role.grants||role.snapshots||role.labels)throw new ScoringRetentionError();
      const [row]=await this.retention`SELECT private_scoring.purge_scoring_private(${this.batchSize}::integer) AS result`;
      const value=row?.result;
      if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!=='generations_deleted,snapshots_deleted'
        ||![value.generations_deleted,value.snapshots_deleted].every(count=>Number.isInteger(count)&&count>=0&&count<=this.batchSize))throw new ScoringRetentionError();
      return{generationsDeleted:value.generations_deleted,snapshotsDeleted:value.snapshots_deleted};
    }catch{throw new ScoringRetentionError();}
  }
}
/** Lifecycle owner invokes bounded work; no hidden interval/background activation. */
export function createPrivateScoringRetention(config:ScoringRetentionConfig):{worker:PostgresScoringRetention;close():Promise<void>}|null {
  if(!config.enabled)return null;
  const retention=postgres(config.databaseUrl,{max:1,prepare:false,connect_timeout:2,idle_timeout:20,onnotice:()=>undefined,
    connection:{statement_timeout:config.statementTimeoutMs,lock_timeout:Math.min(config.statementTimeoutMs,1000)}});
  return{worker:new PostgresScoringRetention(retention,config.batchSize),close:()=>retention.end({timeout:1})};
}
