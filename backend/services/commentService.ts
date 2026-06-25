import { db } from '../db/index.js';
import { comments } from '../db/schema.js';
import { eq, asc, desc } from 'drizzle-orm';
import type { CommentInsert, CommentUpdate } from '../types/index.js';

export async function getAllComments() {
  try {
    const data = await db.select().from(comments).orderBy(desc(comments.created_at));
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getCommentsByRepo(repoId: string) {
  try {
    const data = await db.select().from(comments).where(eq(comments.repo_id, repoId)).orderBy(desc(comments.created_at));
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getCommentsByUser(userId: string) {
  try {
    const data = await db.select().from(comments).where(eq(comments.user_id, userId)).orderBy(desc(comments.created_at));
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getRepliesByParentComment(parentCommentId: string) {
  try {
    const data = await db.select().from(comments).where(eq(comments.parent_comment_id, parentCommentId)).orderBy(asc(comments.created_at));
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getCommentById(commentId: string) {
  try {
    const [data] = await db.select().from(comments).where(eq(comments.comment_id, commentId)).limit(1);
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function createComment(commentData: CommentInsert) {
  try {
    const [data] = await db.insert(comments).values(commentData).returning();
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function updateCommentById(commentId: string, commentData: CommentUpdate) {
  try {
    const [data] = await db.update(comments).set(commentData).where(eq(comments.comment_id, commentId)).returning();
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function deleteCommentById(commentId: string) {
  try {
    const result = await db.delete(comments).where(eq(comments.comment_id, commentId)).returning();
    return { data: null, error: null, count: result.length };
  } catch (error) { return { data: null as any, error: error as any, count: 0 }; }
}
