import { validateRepositoryLifecycle } from '../services/repositoryLifecycle.js';
import { validateRepositoryLineage, type RepositoryLineage } from '../services/repositoryLineage.js';
import type { RepositoryUpsert } from '../contracts/ingestion.v2.js';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

function optionalText(value: unknown, maximum: number, allowBlank = true): boolean {
  return value === undefined || value === null
    || (typeof value === 'string' && value.length <= maximum && (allowBlank || value.trim().length > 0));
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null
    || (typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)));
}

function optionalInteger(value: unknown, minimum: number, maximum: number): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum);
}

function optionalList(value: unknown, maximumItems: number): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= maximumItems
    && value.every((item) => typeof item === 'string' && item.trim().length >= 1 && item.trim().length <= 128));
}

function optionalHttpsDirectory(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string' || value.length > 2_048 || value !== value.trim()) return false;
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return parsed.protocol === 'https:' && parsed.hostname === 'raw.githubusercontent.com'
      && parsed.port === '' && parsed.username === '' && parsed.password === ''
      && parsed.search === '' && parsed.hash === '' && parsed.pathname.endsWith('/')
      && parsed.toString() === value
      && parsed.pathname.split('/').slice(1, -1).every(Boolean)
      && ((segments.length >= 3 && /^[a-f0-9]{40}$/.test(segments[2]))
        || (segments.length >= 5 && segments[2] === 'refs' && segments[3] === 'heads'));
  } catch {
    return false;
  }
}

function optionalSafeSlashPath(value: unknown, maximum: number, filePath: boolean): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value !== value.trim() || value.includes('\\') || value.startsWith('/')
    || value.endsWith('/')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    && (!filePath || segments.at(-1)?.length !== 0);
}

export function isRepositoryUpsert(value: unknown): value is RepositoryUpsert {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (typeof item.github_id !== 'string' || !/^[0-9]{1,32}$/.test(item.github_id)) return false;
  if (typeof item.owner_github_id !== 'string' || !/^[0-9]{1,32}$/.test(item.owner_github_id)) return false;
  try { validateRepositoryLineage(item as RepositoryLineage,item.github_id); } catch { return false; }
  try { if (item.lifecycle != null) validateRepositoryLifecycle(item.lifecycle); } catch { return false; }
  const githubId = BigInt(item.github_id);
  const ownerGithubId = BigInt(item.owner_github_id);
  return githubId > 0n && githubId <= POSTGRES_BIGINT_MAX
    && ownerGithubId > 0n && ownerGithubId <= POSTGRES_BIGINT_MAX
    && typeof item.full_name === 'string' && item.full_name.length >= 3 && item.full_name.length <= 256
    && /^[^/\s]+\/[^/\s]+$/.test(item.full_name)
    && typeof item.owner === 'string' && item.owner.trim().length >= 1 && item.owner.length <= 256
    && typeof item.name === 'string' && item.name.trim().length >= 1 && item.name.length <= 256
    && typeof item.url === 'string' && item.url.length >= 1 && item.url.length <= 2_048
    && optionalText(item.github_node_id, 512)
    && optionalText(item.description, 10_000)
    && optionalText(item.readme, 1_000_000)
    && optionalSafeSlashPath(item.readme_source_path, 1_024, true)
    && optionalSafeSlashPath(item.readme_default_branch, 256, false)
    && optionalHttpsDirectory(item.readme_base_url)
    && optionalText(item.primary_language, 128)
    && optionalList(item.languages, 100)
    && optionalList(item.topics, 200)
    && optionalInteger(item.star_count, 0, POSTGRES_INTEGER_MAX)
    && optionalInteger(item.fork_count, 0, POSTGRES_INTEGER_MAX)
    && optionalInteger(item.open_issues_count, 0, POSTGRES_INTEGER_MAX)
    && optionalInteger(item.readme_length, 0, Number.MAX_SAFE_INTEGER)
    && optionalInteger(item.pushed_days_ago, 0, 100_000)
    && optionalInteger(item.delta_3d, -POSTGRES_INTEGER_MAX - 1, POSTGRES_INTEGER_MAX)
    && optionalInteger(item.delta_7d, -POSTGRES_INTEGER_MAX - 1, POSTGRES_INTEGER_MAX)
    && optionalInteger(item.delta_30d, -POSTGRES_INTEGER_MAX - 1, POSTGRES_INTEGER_MAX)
    && optionalInteger(item.mentionable_users_count, 0, Number.MAX_SAFE_INTEGER)
    && (item.readme_to_codebase_ratio === undefined
      || (typeof item.readme_to_codebase_ratio === 'number'
        && Number.isFinite(item.readme_to_codebase_ratio) && item.readme_to_codebase_ratio >= 0))
    && optionalList(item.recent_commits, 100)
    && (item.recent_commits === undefined
      || (item.recent_commits as unknown[]).every((timestamp) => optionalTimestamp(timestamp)))
    && optionalTimestamp(item.created_at)
    && optionalTimestamp(item.updated_at)
    && optionalTimestamp(item.pushed_at)
    && optionalText(item.discovery_category, 512, false)
    && optionalText(item.discovery_band, 512, false)
    && typeof item.observed_at === 'string' && Number.isFinite(Date.parse(item.observed_at))
    && Date.parse(item.observed_at) >= 1;
}
