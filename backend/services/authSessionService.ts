import crypto from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { sqlClient } from '../db/index.js';

export class SessionRevokedError extends Error {
  readonly statusCode = 401;
  constructor() { super('Your session changed. Please sign in again.'); }
}

export class RefreshTokenRotatedError extends Error {
  readonly code = 'REFRESH_TOKEN_ROTATED';
  constructor() { super('Another request has already refreshed this session. Please retry.'); }
}

/** Use one database clock for admission and reset cutoffs, including sub-ms precision. */
export async function authAttemptStartedAt(): Promise<string> {
  const [row] = await sqlClient`SELECT clock_timestamp()::text AS started_at`;
  return String(row.started_at);
}

type Transaction = TransactionSql;

async function lockAdmissionFence(tx: Transaction, userId: string): Promise<void> {
  // This row belongs to the Auth UUID, so recovery can fence a first login
  // before any product profile exists. Always acquire it before the user lock.
  await tx`INSERT INTO app.auth_session_fences(user_id) VALUES(${userId}::uuid)
    ON CONFLICT (user_id) DO NOTHING`;
  await tx`SELECT user_id FROM app.auth_session_fences WHERE user_id=${userId}::uuid FOR UPDATE`;
}

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
    await lockAdmissionFence(tx, userId);
    if (!await lockOwner(tx, userId)) throw new SessionRevokedError();
    const [row] = await tx`SELECT
      (f.revoked_at IS NULL OR f.revoked_at < ${startedAt}::timestamptz)
      AND (u.sessions_revoked_at IS NULL OR u.sessions_revoked_at < ${startedAt}::timestamptz) AS allowed
      FROM app.users u JOIN app.auth_session_fences f USING (user_id) WHERE u.user_id=${userId}::uuid`;
    if (row.allowed !== true) throw new SessionRevokedError();
    return storeToken(tx, userId);
  });
}

export async function rotateRefreshToken(userId: string, tokenHash: string): Promise<string> {
  return sqlClient.begin(async tx => {
    if (!await lockOwner(tx, userId)) throw new Error('InvalidToken');
    await tx`DELETE FROM app.refresh_tokens WHERE user_id=${userId}::uuid
      AND last_used_at IS NOT NULL AND expires_at<=clock_timestamp()`;
    // Retain only the consumed hash briefly. It can diagnose a parallel loser,
    // but never mint another replacement or expose the winner's credential.
    const consumed = await tx`UPDATE app.refresh_tokens
      SET last_used_at=clock_timestamp(),expires_at=LEAST(expires_at,clock_timestamp()+interval '1 minute')
      WHERE user_id=${userId}::uuid AND token_hash=${tokenHash}
        AND last_used_at IS NULL AND expires_at>clock_timestamp() RETURNING token_id`;
    if (!consumed.length) {
      const rotated = await tx`SELECT token_id FROM app.refresh_tokens WHERE user_id=${userId}::uuid
        AND token_hash=${tokenHash} AND last_used_at IS NOT NULL AND expires_at>clock_timestamp()`;
      if (rotated.length) throw new RefreshTokenRotatedError();
      throw new Error('InvalidToken');
    }
    return storeToken(tx, userId);
  });
}

export async function revokeRefreshSessions(userId: string): Promise<void> {
  await sqlClient.begin(async tx => {
    await lockAdmissionFence(tx, userId);
    await tx`UPDATE app.auth_session_fences SET revoked_at=GREATEST(revoked_at,clock_timestamp())
      WHERE user_id=${userId}::uuid`;
    // Keep the cutoff even when a first login has not provisioned the profile.
    if (!await lockOwner(tx, userId)) return;
    await tx`UPDATE app.users SET sessions_revoked_at=GREATEST(sessions_revoked_at,clock_timestamp())
      WHERE user_id=${userId}::uuid`;
    await tx`DELETE FROM app.refresh_tokens WHERE user_id=${userId}::uuid`;
    await tx`DELETE FROM app.oauth_codes WHERE user_id=${userId}::uuid`;
  });
}
