import { type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  deleteUser,
  initializeAuth,
  onAuthStateChanged,
  signInAnonymously,
  type Auth,
  type Unsubscribe,
} from 'firebase/auth/web-extension';
import { browser } from 'wxt/browser';

import { getFirebaseEnvironment } from '@/config/firebaseEnvironment';
import { getFirebaseApp, resetFirebaseApp } from '@/infrastructure/firebase/firebaseApp';
import {
  hasStoredCredential,
  protectedPersistence,
  removeStoredCredential,
  withCredentialRemoval,
} from '@/infrastructure/firebase/protectedPersistence';

export const FIREBASE_SESSION_ENSURE = 'firebase-session:ensure';

export type FirebaseSessionFailure = 'restore-failed' | 'unavailable';

export type FirebaseSessionOptions = {
  replaceUnrestorable: boolean;
};

export type FirebaseSessionRequest = FirebaseSessionOptions & {
  type: typeof FIREBASE_SESSION_ENSURE;
};

export type FirebaseSessionResponse = { error: FirebaseSessionFailure } | { uid: string };

const sessionFailureMessages: Record<FirebaseSessionFailure, string> = {
  'restore-failed':
    'Your saved session could not be restored. Check your connection, or connect Twitch again.',
  unavailable: 'Firebase authentication is unavailable.',
};

export class FirebaseSessionError extends Error {
  constructor(readonly code: FirebaseSessionFailure) {
    super(sessionFailureMessages[code]);
    this.name = 'FirebaseSessionError';
  }
}

const sessionSyncTimeout = 3_000;
const authInstances = new WeakMap<FirebaseApp, Auth>();

let authPromise: Promise<string> | null = null;
let restoreFailed = false;
let sessionAuthority = false;

export function setFirebaseSessionAuthority() {
  sessionAuthority = true;
}

export function getFirebaseAuth() {
  const app = getFirebaseApp();
  const existing = authInstances.get(app);

  if (existing) {
    return existing;
  }

  const auth = initializeAuth(app, { persistence: protectedPersistence });

  if (getFirebaseEnvironment().useEmulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', {
      disableWarnings: true,
    });
  }

  authInstances.set(app, auth);

  return auth;
}

async function loadAuth(reinitialize: boolean) {
  if (reinitialize) {
    await resetFirebaseApp();
  }

  const auth = getFirebaseAuth();

  await auth.authStateReady();

  return auth;
}

async function storedCredentialExists(auth: Auth) {
  try {
    return await hasStoredCredential(auth);
  } catch {
    throw new FirebaseSessionError('unavailable');
  }
}

async function establishSession(options: FirebaseSessionOptions) {
  const auth = await loadAuth(restoreFailed);

  if (auth.currentUser) {
    restoreFailed = false;
    return auth.currentUser.uid;
  }

  if (await storedCredentialExists(auth)) {
    if (!options.replaceUnrestorable) {
      restoreFailed = true;
      throw new FirebaseSessionError('restore-failed');
    }

    await removeStoredCredential(auth);
  }

  restoreFailed = false;

  const credential = await signInAnonymously(auth);

  return credential.user.uid;
}

function waitForUser(auth: Auth, uid: string) {
  return new Promise<boolean>((resolve) => {
    let unsubscribe: Unsubscribe | null = null;
    let settled = false;
    const finish = (observed: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        unsubscribe?.();
        resolve(observed);
      }
    };
    const timeout = setTimeout(() => {
      finish(false);
    }, sessionSyncTimeout);

    unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user?.uid === uid) {
        finish(true);
      }
    });

    if (settled) {
      unsubscribe();
    }
  });
}

export function parseFirebaseSessionResponse(value: unknown): FirebaseSessionResponse {
  if (value && typeof value === 'object') {
    const response = value as Record<string, unknown>;

    if (typeof response.uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(response.uid)) {
      return { uid: response.uid };
    }

    if (response.error === 'restore-failed') {
      return { error: 'restore-failed' };
    }
  }

  return { error: 'unavailable' };
}

async function requestSessionFromAuthority(options: FirebaseSessionOptions) {
  const auth = await loadAuth(false);

  if (auth.currentUser) {
    return auth.currentUser.uid;
  }

  const request: FirebaseSessionRequest = {
    replaceUnrestorable: options.replaceUnrestorable,
    type: FIREBASE_SESSION_ENSURE,
  };
  const response = parseFirebaseSessionResponse(await browser.runtime.sendMessage(request));

  if ('error' in response) {
    throw new FirebaseSessionError(response.error);
  }

  if (getFirebaseAuth().currentUser?.uid === response.uid) {
    return response.uid;
  }

  if (await waitForUser(getFirebaseAuth(), response.uid)) {
    return response.uid;
  }

  const reloaded = await loadAuth(true);

  if (reloaded.currentUser?.uid === response.uid) {
    return response.uid;
  }

  throw new FirebaseSessionError('unavailable');
}

export function ensureAnonymousAuth(
  options: FirebaseSessionOptions = { replaceUnrestorable: false },
) {
  const start = () =>
    sessionAuthority ? establishSession(options) : requestSessionFromAuthority(options);
  const attempt = authPromise
    ? options.replaceUnrestorable
      ? authPromise.catch(start)
      : authPromise
    : start();
  const tracked: Promise<string> = attempt.catch((cause: unknown) => {
    if (authPromise === tracked) {
      authPromise = null;
    }

    throw cause;
  });

  authPromise = tracked;

  return tracked;
}

export function isFirebaseSessionRequest(value: unknown): value is FirebaseSessionRequest {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const message = value as Record<string, unknown>;

  return (
    Object.keys(message).length === 2 &&
    message.type === FIREBASE_SESSION_ENSURE &&
    typeof message.replaceUnrestorable === 'boolean'
  );
}

export async function answerFirebaseSessionRequest(
  request: FirebaseSessionRequest,
): Promise<FirebaseSessionResponse> {
  try {
    return { uid: await ensureAnonymousAuth(request) };
  } catch (cause) {
    return {
      error:
        cause instanceof FirebaseSessionError && cause.code === 'restore-failed'
          ? 'restore-failed'
          : 'unavailable',
    };
  }
}

export async function getFirebaseIdToken() {
  await ensureAnonymousAuth();

  const user = getFirebaseAuth().currentUser;

  if (!user) {
    authPromise = null;
    throw new FirebaseSessionError('unavailable');
  }

  return user.getIdToken();
}

export async function deleteFirebaseAccount() {
  const auth = await loadAuth(false);

  await withCredentialRemoval(async () => {
    if (auth.currentUser) {
      await deleteUser(auth.currentUser);
    }
  });

  if (await hasStoredCredential(auth).catch(() => false)) {
    await removeStoredCredential(auth);
  }

  authPromise = null;
}
