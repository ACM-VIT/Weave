import { db } from '../db/index.js';
import { boardsContainers, containerBoards, boards } from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { BoardsContainerInsert, BoardsContainerRow, BoardRow } from '../types/index.js';

type CreateContainerResult =
  | { data: { container: BoardsContainerRow; boards: BoardRow[] }; error?: undefined }
  | { data?: undefined; error: unknown };

export async function createContainer(containerData: BoardsContainerInsert) {
  try {
    const [data] = await db.insert(boardsContainers).values(containerData).returning();
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getContainersByUser(userId: string) {
  try {
    const data = await db.select().from(boardsContainers).where(eq(boardsContainers.user_id, userId)).orderBy(desc(boardsContainers.created_at));
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function getContainerById(containerId: string) {
  try {
    const [data] = await db.select().from(boardsContainers).where(eq(boardsContainers.container_id, containerId)).limit(1);
    if (!data) throw { code: 'PGRST116', message: 'Not found' };
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function addBoardToContainer(containerId: string, boardId: string) {
  try {
    const [data] = await db.insert(containerBoards).values({ container_id: containerId, board_id: boardId }).returning();
    return { data, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function removeBoardFromContainer(containerId: string, boardId: string) {
  try {
    const result = await db.delete(containerBoards).where(and(eq(containerBoards.container_id, containerId), eq(containerBoards.board_id, boardId))).returning();
    return { data: null, error: null, count: result.length };
  } catch (error) { return { data: null as any, error: error as any, count: 0 }; }
}

export async function deleteContainer(containerId: string) {
  try {
    const result = await db.delete(boardsContainers).where(eq(boardsContainers.container_id, containerId)).returning();
    return { data: null, error: null, count: result.length };
  } catch (error) { return { data: null as any, error: error as any, count: 0 }; }
}

export async function getBoardsForContainer(containerId: string) {
  try {
    const result = await db.select({
      board_id: containerBoards.board_id,
      added_at: containerBoards.added_at,
      board: boards
    })
    .from(containerBoards)
    .leftJoin(boards, eq(containerBoards.board_id, boards.board_id))
    .where(eq(containerBoards.container_id, containerId))
    .orderBy(desc(containerBoards.added_at));

    return { data: result, error: null };
  } catch (error) { return { data: null as any, error: error as any }; }
}

export async function createContainerWithDefaults(userId: string, containerName = 'Default Boards Container'): Promise<CreateContainerResult> {
  try {
    const result = await db.execute(sql`SELECT create_container_with_defaults(${userId}::uuid, ${containerName}) as data`);
    return { data: result[0].data as any, error: undefined };
  } catch (error) { return { error }; }
}
