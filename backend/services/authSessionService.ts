import crypto from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { sqlClient } from '../db/index.js';

export class SessionRevokedError extends Error {
  readonly statusCode = 401;
  constructor() { super('Your session changed. Please sign in again.'); }
}

/** Use one database clock for admission and reset cutoffs, including sub-ms precision. */
export async function authAttemptStartedAt(): Promise<string> {
  const [row] = await sqlClient`SELECT clock_timestamp()::text AS started_at`;
  return String(row.started_at);
}

type Transaction = TransactionSql;

async function lockOwner(tx: Transaction, userId: string): Promise<boolean> {
  const rows = await tx`SELECT user_id FROM app.users WHERE user_id=${userId}::uuid FOR UPDATE`;
  return rows.length === 1;
}

async function storeToken(tx: Transaction, userId: string): Promise<string> {
  const token = crypto.randomBytes(40).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await tx`INSERT INTO app.refresh_tokens(user_id,token_hash,expires_at)
    VALUES(${userId}::uuid,${hash},clock_timestamp()+interval '30 days')`;
  return token;
}

export async function issueRefreshToken(userId: string, startedAt: string): Promise<string> {
  return sqlClient.begin(async tx => {
    if (!await lockOwner(tx, userId)) throw new SessionRevokedError();
    const [row] = await tx`SELECT sessions_revoked_at IS NULL OR sessions_revoked_at < ${startedAt}::timestamptz AS allowed
      FROM app.users WHERE user_id=${userId}::uuid`;
    if (row.allowed !== true) throw new SessionRevokedError();
    return storeToken(tx, userId);
  });
}

export async function rotateRefreshToken(userId: string, tokenHash: string): Promise<string> {
  return sqlClient.begin(async tx => {
    if (!await lockOwner(tx, userId)) throw new Error('InvalidToken');
    const deleted = await tx`DELETE FROM app.refresh_tokens WHERE user_id=${userId}::uuid
      AND token_hash=${tokenHash} AND expires_at>clock_timestamp() RETURNING token_id`;
    if (!deleted.length) throw new Error('InvalidToken');
    return storeToken(tx, userId);
  });
}

export async function revokeRefreshSessions(userId: string): Promise<void> {
  await sqlClient.begin(async tx => {
    // Password recovery is also valid for an Auth identity that never acquired
    // a product profile; there cannot be app sessions for that identity yet.
    if (!await lockOwner(tx, userId)) return;
    await tx`UPDATE app.users SET sessions_revoked_at=GREATEST(sessions_revoked_at,clock_timestamp())
      WHERE user_id=${userId}::uuid`;
    await tx`DELETE FROM app.refresh_tokens WHERE user_id=${userId}::uuid`;
    await tx`DELETE FROM app.oauth_codes WHERE user_id=${userId}::uuid`;
  });
}
