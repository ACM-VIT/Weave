import {
  getStorageItem,
  getStorageItemStrict,
  removeStorageItem,
  setStorageItem,
} from '../utils/storage';
import {
  authSessionLifecycle,
  SessionRefreshPendingError,
  type SessionLease,
} from './session-lifecycle';

export type RawAuthenticatedSession<TUser = unknown> = {
  accessToken: string;
  user: TUser;
};

export type AuthenticatedSession<TUser = unknown> = RawAuthenticatedSession<TUser> & {
  sessionGeneration: number;
};

const SESSION_RESTORE_BLOCKED_KEY = 'session_restore_blocked';
let storageMutationTail: Promise<void> = Promise.resolve();

export class LogoutNotCompletedError extends Error {
  constructor(cause: unknown, readonly restoreUserWhenPrepared?: Promise<boolean>) {
    super('Logout could not be completed safely. Please try again.');
    this.name = 'LogoutNotCompletedError';
    Object.assign(this, { cause });
  }
}

function queueStorageMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageMutationTail
    .catch(() => undefined)
    .then(operation);
  storageMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

export function storeAccessTokenForLease(lease: SessionLease, token: string): Promise<void> {
  return queueStorageMutation(async () => {
    lease.assertCurrent();
    await setStorageItem('access_token', token);
    lease.assertCurrent();
  });
}

function commitEstablishedSession(lease: SessionLease, token: string): Promise<void> {
  return queueStorageMutation(async () => {
    lease.assertCurrent();
    await setStorageItem('access_token', token);
    lease.assertCurrent();
    try {
      await removeStorageItem(SESSION_RESTORE_BLOCKED_KEY);
    } catch (error) {
      await removeStorageItem('access_token').catch(() => undefined);
      throw error;
    }
    lease.assertCurrent();
  });
}

function protectEstablishment(): Promise<void> {
  return queueStorageMutation(async () => {
    await setStorageItem(SESSION_RESTORE_BLOCKED_KEY, '1');
    await removeStorageItem('access_token');
  });
}

export async function isSessionRestoreBlocked(): Promise<boolean> {
  return queueStorageMutation(async () => (
    await getStorageItemStrict(SESSION_RESTORE_BLOCKED_KEY)
  ) === '1');
}

export function retireSessionIfCurrent(
  generation: number,
  expectedToken?: string,
  assertAttemptCurrent: () => void = () => undefined,
): Promise<boolean> {
  return queueStorageMutation(async () => {
    assertAttemptCurrent();
    if (!authSessionLifecycle.isCurrent(generation)) return false;
    if (expectedToken !== undefined) {
      const currentToken = await getStorageItemStrict('access_token');
      assertAttemptCurrent();
      if (!authSessionLifecycle.isCurrent(generation) || currentToken !== expectedToken) return false;
    }
    // Persist the fail-closed marker before retiring the in-memory generation.
    // If storage is unavailable, keep the existing session instead of claiming
    // a durable logout that could be undone on restart.
    await setStorageItem(SESSION_RESTORE_BLOCKED_KEY, '1');
    assertAttemptCurrent();
    if (!authSessionLifecycle.isCurrent(generation)) return false;
    if (!authSessionLifecycle.retire(generation)) return false;
    await removeStorageItem('access_token').catch(() => undefined);
    return true;
  });
}

type LogoutPreparation = {
  accessToken: string | null;
  restoreBlocked: boolean;
};

function prepareLogout(): Promise<LogoutPreparation> {
  return queueStorageMutation(async () => {
    let restoreBlocked = false;
    try {
      await setStorageItem(SESSION_RESTORE_BLOCKED_KEY, '1');
      restoreBlocked = true;
    } catch {
      // The server request must still run. Without a durable marker we retain
      // the current token and restore the UI if server revocation also fails.
    }

    const accessToken = await getStorageItem('access_token').catch(() => null);
    if (restoreBlocked) await removeStorageItem('access_token').catch(() => undefined);
    return { accessToken, restoreBlocked };
  });
}

function clearAccessTokenAfterServerLogout(): Promise<void> {
  return queueStorageMutation(() => removeStorageItem('access_token'));
}

export async function establishSession<TUser>(
  request: () => Promise<RawAuthenticatedSession<TUser>>,
): Promise<AuthenticatedSession<TUser>> {
  return authSessionLifecycle.runTransition(async (lease) => {
    const session = await request();
    if (!session || typeof session.accessToken !== 'string' || !session.accessToken) {
      throw new Error('Authentication response did not contain an access token.');
    }

    await commitEstablishedSession(lease, session.accessToken);
    lease.assertCurrent();

    return {
      ...session,
      sessionGeneration: lease.generation,
    };
  }, async () => {
    await protectEstablishment();
    return undefined;
  });
}

export async function revokeSession<T>(
  request: (accessToken: string | null) => Promise<T>,
): Promise<T> {
  let logoutPreparation: LogoutPreparation | undefined;
  let logoutPreparationPromise: Promise<LogoutPreparation> | undefined;
  let logoutGeneration: number | undefined;
  try {
    return await authSessionLifecycle.runTransition<T, LogoutPreparation>(async (_lease, preparation) => {
      // The coordinator waits for any older refresh response first. Reading and
      // clearing is prepared as soon as logout starts; the network request still
      // waits for the rotated cookie and therefore wins last.
      try {
        const result = await request(preparation.accessToken);
        if (!preparation.restoreBlocked) await clearAccessTokenAfterServerLogout();
        return result;
      } catch (error) {
        if (!preparation.restoreBlocked) throw new LogoutNotCompletedError(error);
        throw error;
      }
    }, async (lease) => {
      logoutGeneration = lease.generation;
      logoutPreparationPromise = prepareLogout();
      logoutPreparation = await logoutPreparationPromise;
      return logoutPreparation;
    });
  } catch (error) {
    // A bounded wait can fail before the request callback's own error wrapper.
    // Unknown preparation reports failure now, but its eventual cleanup outcome
    // must be reconciled before restoring a viewer. Never wait on storage here
    // or reclassify supersession as failure of the current session.
    if (error instanceof SessionRefreshPendingError
      && !logoutPreparation?.restoreBlocked
      && logoutGeneration !== undefined
      && authSessionLifecycle.isCurrent(logoutGeneration)) {
      const restoreUserWhenPrepared = logoutPreparation === undefined
        ? logoutPreparationPromise?.then(result => !result.restoreBlocked, () => false) ?? Promise.resolve(false)
        : undefined;
      throw new LogoutNotCompletedError(error, restoreUserWhenPrepared);
    }
    throw error;
  }
}
