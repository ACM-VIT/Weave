import { db } from '../db/index.js';
import { activities } from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { ActivityInsert, ActivityUpdate } from '../types/index.js';

export async function toggleRepoLike(userId: string, repoId: string) {
  try {
    const result = await db.execute(sql`SELECT * FROM toggle_repo_like(${userId}::uuid, ${repoId}::uuid)`);
    return { data: result[0] || null, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function toggleRepoSave(userId: string, repoId: string) {
  try {
    const result = await db.execute(sql`SELECT * FROM toggle_repo_save(${userId}::uuid, ${repoId}::uuid)`);
    return { data: result[0] || null, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getAllActivity() {
  try {
    const data = await db.select().from(activities).orderBy(desc(activities.time_spent));
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getUserActivity(userId: string) {
  try {
    const data = await db.select().from(activities).where(eq(activities.user_id, userId)).orderBy(desc(activities.time_spent));
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getSavedActivity(userId: string) {
  try {
    const data = await db.select().from(activities).where(and(eq(activities.user_id, userId), eq(activities.is_saved, true))).orderBy(desc(activities.time_spent));
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getActivityByUserAndRepo(userId: string, repoId: string) {
  try {
    const [data] = await db.select().from(activities).where(and(eq(activities.user_id, userId), eq(activities.repo_id, repoId))).limit(1);
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function updateActivityByUserAndRepo(userId: string, repoId: string, activityData: ActivityUpdate) {
  try {
    const [data] = await db.update(activities)
      .set(activityData)
      .where(and(eq(activities.user_id, userId), eq(activities.repo_id, repoId)))
      .returning();
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getActivityById(activityId: string) {
  try {
    const [data] = await db.select().from(activities).where(eq(activities.activity_id, activityId)).limit(1);
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function createActivity(activityData: ActivityInsert) {
  try {
    const [data] = await db.insert(activities).values(activityData).returning();
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function updateActivityById(activityId: string, activityData: ActivityUpdate) {
  try {
    const [data] = await db.update(activities).set(activityData).where(eq(activities.activity_id, activityId)).returning();
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function deleteActivityById(activityId: string) {
  try {
    const result = await db.delete(activities).where(eq(activities.activity_id, activityId)).returning();
    return { data: null, error: null, count: result.length };
  } catch (error) { return { data: null as any, error: error as any, count: 0 }; }
}
