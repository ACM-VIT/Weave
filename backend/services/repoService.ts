import { db } from '../db/index.js';
import { repos } from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import type { RepoInsert, RepoUpdate, PaginationParams } from '../types/index.js';

export async function getAllRepos({ limit, offset }: PaginationParams) {
  try {
    const data = await db.select().from(repos).orderBy(desc(repos.created_at)).limit(limit).offset(offset);
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getRepoById(repoId: string) {
  try {
    const [data] = await db.select().from(repos).where(eq(repos.repo_id, repoId)).limit(1);
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function createRepo(repoData: RepoInsert) {
  try {
    const [data] = await db.insert(repos).values(repoData).returning();
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function incrementRepoViews(repoId: string) {
  try {
    const result = await db.execute(sql`SELECT increment_repo_views(${repoId}::uuid) as found`);
    return { data: result[0]?.found ?? false, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function updateRepoById(repoId: string, repoData: RepoUpdate) {
  try {
    const [data] = await db.update(repos).set({
      ...repoData,
      updated_at: sql`now()`
    }).where(eq(repos.repo_id, repoId)).returning();
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}
