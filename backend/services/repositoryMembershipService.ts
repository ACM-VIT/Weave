import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import type { InteractionEventV2 } from '../contracts/interactions.v2.js';
import { sqlClient } from '../db/index.js';
import { processInteractionBatchV2InTransaction } from './activityV2Service.js';
import {
  getRepositoryMembershipSavedState,
  setRepositorySaved,
} from './savedRepositoryService.js';

type TransactionSql = postgres.TransactionSql;

export interface RepositoryMembershipState {
  repository_id: string;
  saved: boolean;
  save_state_changed: boolean;
}

export interface RepositoryListSyncResult extends RepositoryMembershipState {
  /** Existing API name retained for compatibility. */
  collection_ids: string[];
  /** Existing legacy Board memberships exposed through the same List DTO. */
  board_ids: string[];
  /** Product-facing IDs are source-qualified because both stores use UUIDs. */
  selected_list_ids: string[];
}

export interface MembershipDifference {
  added: string[];
  removed: string[];
}

export function diffListMemberships(currentIds: string[], desiredIds: string[]): MembershipDifference {
  const current = new Set(currentIds);
  const desired = new Set(desiredIds);
  return {
    added: [...desired].filter((id) => !current.has(id)),
    removed: [...current].filter((id) => !desired.has(id)),
  };
}

export function productListId(source: 'collection' | 'legacy-board', id: string): string {
  return `${source}:${id}`;
}

function statusError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

async function lockUserMembershipState(tx: TransactionSql, userId: string): Promise<void> {
  // Every interaction already serializes through this row. Membership writes
  // use the same first lock so saved-state changes and feed invalidation share
  // one deterministic order.
  await tx`
    INSERT INTO app.user_feed_state (user_id) VALUES (${userId}::uuid)
    ON CONFLICT (user_id) DO NOTHING
  `;
  await tx`
    SELECT user_id FROM app.user_feed_state
    WHERE user_id=${userId}::uuid
    FOR UPDATE
  `;
}

async function lockRepositoryMemberships(
  tx: TransactionSql,
  userId: string,
  repositoryIds: string[],
): Promise<string[]> {
  const ordered = [...new Set(repositoryIds)].sort();
  for (const repositoryId of ordered) {
    await tx`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${repositoryId}`},0))
    `;
  }
  return ordered;
}

async function repositoryIsSavedAnywhere(
  tx: TransactionSql,
  userId: string,
  repositoryId: string,
): Promise<boolean> {
  return getRepositoryMembershipSavedState(tx, userId, repositoryId);
}

async function recomputeRepositorySaved(
  tx: TransactionSql,
  userId: string,
  repositoryId: string,
): Promise<RepositoryMembershipState> {
  const saved = await repositoryIsSavedAnywhere(tx, userId, repositoryId);
  const saveStateChanged = await setRepositorySaved(tx, userId, repositoryId, saved);
  return { repository_id: repositoryId, saved, save_state_changed: saveStateChanged };
}

async function invalidateFutureFeed(tx: TransactionSql, userId: string): Promise<void> {
  await tx`
    UPDATE app.user_feed_state
    SET feed_version=feed_version+1,updated_at=now()
    WHERE user_id=${userId}::uuid
  `;
}

function validateMembershipEvent(
  event: InteractionEventV2,
  repositoryId: string,
  saved: boolean,
): void {
  const expectedType = saved ? 'save' : 'unsave';
  if (event.repo_id !== repositoryId || event.event_type !== expectedType) {
    throw statusError(400, `Membership event must be a ${expectedType} event matching repositoryId.`);
  }
}

function createServerMembershipEvent(state: RepositoryMembershipState): InteractionEventV2 {
  return {
    event_id: randomUUID(), schema_version: 2, session_id: randomUUID(),
    serve_id: null, position: null, repo_id: state.repository_id,
    event_type: state.saved ? 'save' : 'unsave', dwell_ms: null,
    client_occurred_at: new Date().toISOString(),
    context: { save_state_source: 'list_membership', origin: 'server_membership' },
  };
}

async function recordMembershipEvent(
  tx: TransactionSql,
  userId: string,
  event: InteractionEventV2 | undefined,
  state: RepositoryMembershipState,
): Promise<void> {
  // Legacy callers submit their own interaction after the membership response.
  // Only deletion paths explicitly request a server-generated event.
  if (!state.save_state_changed || !event) return;
  validateMembershipEvent(event, state.repository_id, state.saved);
  await processInteractionBatchV2InTransaction(tx, userId, [{
    ...event,
    // Membership services already derived and committed the save state. This
    // marker makes the event telemetry-only so retries cannot resurrect a repo
    // after its final List membership has been removed.
    context: { ...event.context, save_state_source: 'list_membership' },
  }]);
}

async function recomputeMany(
  tx: TransactionSql,
  userId: string,
  repositoryIds: string[],
): Promise<RepositoryMembershipState[]> {
  const states: RepositoryMembershipState[] = [];
  for (const repositoryId of [...new Set(repositoryIds)].sort()) {
    states.push(await recomputeRepositorySaved(tx, userId, repositoryId));
  }
  const changed = states.filter(state => state.save_state_changed);
  if (changed.length) {
    await invalidateFutureFeed(tx, userId);
    await processInteractionBatchV2InTransaction(tx, userId, changed.map(createServerMembershipEvent));
  }
  return states;
}

export async function syncRepositoryLists(
  userId: string,
  repositoryId: string,
  desiredCollectionIds: string[],
  desiredBoardIds: string[] | undefined,
  event?: InteractionEventV2,
): Promise<RepositoryListSyncResult> {
  const selectedCollectionIds = [...new Set(desiredCollectionIds)];
  return sqlClient.begin(async (tx) => {
    let selectedBoardIds = [...new Set(desiredBoardIds ?? [])];
    await lockUserMembershipState(tx, userId);
    await lockRepositoryMemberships(tx, userId, [repositoryId]);

    const repository = await tx`
      SELECT 1 FROM app.repos
      WHERE repo_id=${repositoryId}::uuid AND status='active'
    `;
    if (!repository.length) throw statusError(404, 'Repository not found.');

    if (selectedCollectionIds.length) {
      const owned = await tx`
        SELECT collection_id FROM app.board_collections
        WHERE user_id=${userId}::uuid
          AND collection_id=ANY(${selectedCollectionIds}::uuid[])
      `;
      if (owned.length !== selectedCollectionIds.length) {
        throw statusError(400, 'One or more Lists were not found.');
      }
    }
    if (selectedBoardIds.length) {
      const owned = await tx`
        SELECT board_id FROM app.boards
        WHERE user_id=${userId}::uuid
          AND board_id=ANY(${selectedBoardIds}::uuid[])
      `;
      if (owned.length !== selectedBoardIds.length) {
        throw statusError(400, 'One or more Lists were not found.');
      }
    }

    const currentCollectionRows = await tx`
      SELECT membership.collection_id
      FROM app.collection_repos membership
      JOIN app.board_collections collection USING(collection_id)
      WHERE membership.repo_id=${repositoryId}::uuid AND collection.user_id=${userId}::uuid
    `;
    const currentBoardRows = await tx`
      SELECT membership.board_id
      FROM app.board_repos membership
      JOIN app.boards board USING(board_id)
      WHERE membership.repo_id=${repositoryId}::uuid AND board.user_id=${userId}::uuid
    `;
    if (desiredBoardIds === undefined) {
      selectedBoardIds = currentBoardRows.map((row) => String(row.board_id));
    }
    const collectionDifference = diffListMemberships(
      currentCollectionRows.map((row) => String(row.collection_id)),
      selectedCollectionIds,
    );
    const boardDifference = diffListMemberships(
      currentBoardRows.map((row) => String(row.board_id)),
      selectedBoardIds,
    );

    if (collectionDifference.removed.length) {
      await tx`
        DELETE FROM app.collection_repos
        WHERE repo_id=${repositoryId}::uuid
          AND collection_id=ANY(${collectionDifference.removed}::uuid[])
      `;
    }
    for (const listId of collectionDifference.added) {
      await tx`
        INSERT INTO app.collection_repos(collection_id,repo_id,added_by)
        VALUES(${listId}::uuid,${repositoryId}::uuid,${userId}::uuid)
        ON CONFLICT (collection_id,repo_id) DO NOTHING
      `;
    }
    if (boardDifference.removed.length) {
      await tx`
        DELETE FROM app.board_repos
        WHERE repo_id=${repositoryId}::uuid
          AND board_id=ANY(${boardDifference.removed}::uuid[])
      `;
    }
    for (const listId of boardDifference.added) {
      await tx`
        INSERT INTO app.board_repos(board_id,repo_id,added_by)
        VALUES(${listId}::uuid,${repositoryId}::uuid,${userId}::uuid)
        ON CONFLICT (board_id,repo_id) DO NOTHING
      `;
    }
    const touchedListIds = [
      ...collectionDifference.added,
      ...collectionDifference.removed,
    ];
    if (touchedListIds.length) {
      await tx`
        UPDATE app.board_collections SET updated_at=now()
        WHERE collection_id=ANY(${touchedListIds}::uuid[]) AND user_id=${userId}::uuid
      `;
    }

    const state = await recomputeRepositorySaved(tx, userId, repositoryId);
    if (state.save_state_changed) await invalidateFutureFeed(tx, userId);
    await recordMembershipEvent(tx, userId, event, state);
    return {
      ...state,
      collection_ids: selectedCollectionIds,
      board_ids: selectedBoardIds,
      selected_list_ids: [
        ...selectedCollectionIds.map((id) => productListId('collection', id)),
        ...selectedBoardIds.map((id) => productListId('legacy-board', id)),
      ],
    };
  });
}

export async function deleteRepositoryList(
  userId: string,
  listId: string,
): Promise<{ list_id: string; repository_states: RepositoryMembershipState[] } | null> {
  return sqlClient.begin(async (tx) => {
    await lockUserMembershipState(tx, userId);
    const owned = await tx`
      SELECT collection_id FROM app.board_collections
      WHERE collection_id=${listId}::uuid AND user_id=${userId}::uuid
    `;
    if (!owned.length) return null;

    const memberships = await tx`
      SELECT repo_id FROM app.collection_repos
      WHERE collection_id=${listId}::uuid
      ORDER BY repo_id
    `;
    const repositoryIds = await lockRepositoryMemberships(
      tx,
      userId,
      memberships.map((row) => String(row.repo_id)),
    );
    await tx`
      DELETE FROM app.board_collections
      WHERE collection_id=${listId}::uuid AND user_id=${userId}::uuid
    `;
    const repositoryStates = await recomputeMany(tx, userId, repositoryIds);
    return { list_id: listId, repository_states: repositoryStates };
  });
}

export async function addRepositoryToBoard(
  userId: string,
  boardId: string,
  repositoryId: string,
  event: InteractionEventV2,
): Promise<RepositoryMembershipState> {
  return sqlClient.begin(async (tx) => {
    await lockUserMembershipState(tx, userId);
    await lockRepositoryMemberships(tx, userId, [repositoryId]);
    const owned = await tx`
      SELECT 1 FROM app.boards
      WHERE board_id=${boardId}::uuid AND user_id=${userId}::uuid
    `;
    if (!owned.length) throw statusError(404, 'Board not found.');
    const repository = await tx`
      SELECT 1 FROM app.repos
      WHERE repo_id=${repositoryId}::uuid AND status='active'
    `;
    if (!repository.length) throw statusError(404, 'Repository not found.');

    await tx`
      INSERT INTO app.board_repos(board_id,repo_id,added_by)
      VALUES(${boardId}::uuid,${repositoryId}::uuid,${userId}::uuid)
      ON CONFLICT (board_id,repo_id) DO NOTHING
    `;
    const state = await recomputeRepositorySaved(tx, userId, repositoryId);
    if (state.save_state_changed) await invalidateFutureFeed(tx, userId);
    await recordMembershipEvent(tx, userId, event, state);
    return state;
  });
}

export async function removeRepositoryFromBoard(
  userId: string,
  boardId: string,
  repositoryId: string,
): Promise<RepositoryMembershipState | null> {
  return sqlClient.begin(async (tx) => {
    await lockUserMembershipState(tx, userId);
    await lockRepositoryMemberships(tx, userId, [repositoryId]);
    const removed = await tx`
      DELETE FROM app.board_repos membership
      USING app.boards board
      WHERE membership.board_id=board.board_id
        AND membership.board_id=${boardId}::uuid
        AND membership.repo_id=${repositoryId}::uuid
        AND board.user_id=${userId}::uuid
      RETURNING membership.board_id
    `;
    if (!removed.length) return null;
    const state = await recomputeRepositorySaved(tx, userId, repositoryId);
    if (state.save_state_changed) await invalidateFutureFeed(tx, userId);
    await recordMembershipEvent(tx, userId, createServerMembershipEvent(state), state);
    return state;
  });
}

export async function deleteRepositoryBoard(
  userId: string,
  boardId: string,
): Promise<{ board_id: string; repository_states: RepositoryMembershipState[] } | null> {
  return sqlClient.begin(async (tx) => {
    await lockUserMembershipState(tx, userId);
    const owned = await tx`
      SELECT board_id FROM app.boards
      WHERE board_id=${boardId}::uuid AND user_id=${userId}::uuid
    `;
    if (!owned.length) return null;
    const memberships = await tx`
      SELECT repo_id FROM app.board_repos
      WHERE board_id=${boardId}::uuid
      ORDER BY repo_id
    `;
    const repositoryIds = await lockRepositoryMemberships(
      tx,
      userId,
      memberships.map((row) => String(row.repo_id)),
    );
    await tx`
      DELETE FROM app.boards
      WHERE board_id=${boardId}::uuid AND user_id=${userId}::uuid
    `;
    const repositoryStates = await recomputeMany(tx, userId, repositoryIds);
    return { board_id: boardId, repository_states: repositoryStates };
  });
}
