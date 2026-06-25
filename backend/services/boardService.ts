import { db } from '../db/index.js';
import { boards, boardRepos, repos } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import type { BoardInsert } from '../types/index.js';

export async function createBoard(boardData: BoardInsert) {
  try {
    const [data] = await db.insert(boards).values(boardData).returning();
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getBoardsByUser(userId: string) {
  try {
    const data = await db.select().from(boards).where(eq(boards.user_id, userId)).orderBy(desc(boards.created_at));
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getBoardById(boardId: string) {
  try {
    const [data] = await db.select().from(boards).where(eq(boards.board_id, boardId)).limit(1);
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function addRepoToBoard(boardId: string, repoId: string) {
  try {
    const [data] = await db.insert(boardRepos).values({ board_id: boardId, repo_id: repoId }).returning();
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function removeRepoFromBoard(boardId: string, repoId: string) {
  try {
    const result = await db.delete(boardRepos).where(and(eq(boardRepos.board_id, boardId), eq(boardRepos.repo_id, repoId))).returning();
    return { data: null, error: null, count: result.length };
  } catch (error) { return { data: null as any, error: error as any, count: 0 }; }
}

export async function deleteBoard(boardId: string) {
  try {
    const result = await db.delete(boards).where(eq(boards.board_id, boardId)).returning();
    return { data: null, error: null, count: result.length };
  } catch (error) { return { data: null as any, error: error as any, count: 0 }; }
}

export async function getReposForBoard(boardId: string) {
  try {
    const result = await db.select({
      repo_id: boardRepos.repo_id,
      added_at: boardRepos.added_at,
      repo: repos
    })
    .from(boardRepos)
    .leftJoin(repos, eq(boardRepos.repo_id, repos.repo_id))
    .where(eq(boardRepos.board_id, boardId))
    .orderBy(desc(boardRepos.added_at));

    return { data: result, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}
