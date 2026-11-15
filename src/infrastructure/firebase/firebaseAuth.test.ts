import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

type RestoreMode = 'ok' | 'revoked' | 'transient';

type FakeUser = {
  getIdToken: ReturnType<typeof vi.fn>;
  uid: string;
};

type FakeAuth = {
  authStateReady(): Promise<void>;
  config: { apiKey: string };
  currentUser: FakeUser | null;
  listeners: Array<(user: FakeUser | null) => void>;
  name: string;
};

type Platform = {
  app: { id: number };
  auths: FakeAuth[];
  createdUsers: number;
  credential: string | null;
  mode: RestoreMode;
  sendMessage: Mock<(message: unknown) => Promise<unknown>>;
  storageAvailable: boolean;
  tokenRefreshes: number;
};

const platform = vi.hoisted((): Platform => ({
  app: { id: 0 },
  auths: [],
  createdUsers: 0,
  credential: null,
  mode: 'ok',
  sendMessage: vi.fn(),
  storageAvailable: true,
  tokenRefreshes: 0,
}));

function createUser(uid: string): FakeUser {
  return {
    getIdToken: vi.fn(() => {
      platform.tokenRefreshes += 1;
      return Promise.resolve(`token-${uid}-${platform.tokenRefreshes}`);
    }),
    uid,
  };
}

vi.mock('@/config/firebaseEnvironment', () => ({
  getFirebaseEnvironment: () => ({ useEmulators: false }),
}));

vi.mock('@/infrastructure/firebase/firebaseApp', () => ({
  getFirebaseApp: () => platform.app,
  resetFirebaseApp: vi.fn(() => {
    platform.app = { id: platform.app.id + 1 };
    return Promise.resolve();
  }),
}));

vi.mock('@/infrastructure/firebase/protectedPersistence', () => ({
  hasStoredCredential: () =>
    platform.storageAvailable
      ? Promise.resolve(platform.credential !== null)
      : Promise.reject(new Error('IndexedDB is unavailable')),
  protectedPersistence: {},
  removeStoredCredential: vi.fn(() => {
    platform.credential = null;
    return Promise.resolve();
  }),
  withCredentialRemoval: vi.fn((operation: () => Promise<unknown>) => operation()),
}));

vi.mock('firebase/auth/web-extension', () => ({
  connectAuthEmulator: vi.fn(),
  deleteUser: vi.fn((user: FakeUser) => {
    if (platform.credential === user.uid) {
      platform.credential = null;
    }

    return Promise.resolve();
  }),
  initializeAuth: vi.fn(() => {
    const auth: FakeAuth = {
      authStateReady: () => {
        if (platform.credential && platform.mode === 'ok' && platform.storageAvailable) {
          auth.currentUser ??= createUser(platform.credential);
        }

        return Promise.resolve();
      },
      config: { apiKey: 'api-key' },
      currentUser: null,
      listeners: [],
      name: '[DEFAULT]',
    };

    platform.auths.push(auth);

    return auth;
  }),
  onAuthStateChanged: vi.fn((auth: FakeAuth, listener: (user: FakeUser | null) => void) => {
    auth.listeners.push(listener);

    return () => {
      auth.listeners = auth.listeners.filter((item) => item !== listener);
    };
  }),
  signInAnonymously: vi.fn((auth: FakeAuth) => {
    platform.createdUsers += 1;

    const user = createUser(`new-user-${platform.createdUsers}`);

    platform.credential = user.uid;
    auth.currentUser = user;

    return Promise.resolve({ user });
  }),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      sendMessage: platform.sendMessage,
    },
  },
}));

async function loadAuthModule(authority: boolean) {
  vi.resetModules();

  const module = await import('@/infrastructure/firebase/firebaseAuth');

  if (authority) {
    module.setFirebaseSessionAuthority();
  }

  return module;
}

describe('Firebase session lifecycle', () => {
  beforeEach(() => {
    platform.app = { id: 0 };
    platform.auths = [];
    platform.createdUsers = 0;
    platform.credential = null;
    platform.mode = 'ok';
    platform.sendMessage.mockReset();
    platform.storageAvailable = true;
    platform.tokenRefreshes = 0;
  });

  it('restores the persisted anonymous user without creating another one', async () => {
    platform.credential = 'existing-user';

    const auth = await loadAuthModule(true);

    await expect(auth.ensureAnonymousAuth()).resolves.toBe('existing-user');
    expect(platform.createdUsers).toBe(0);
  });

  it('keeps the same user across service-worker and browser restarts', async () => {
    const firstRun = await loadAuthModule(true);
    const uid = await firstRun.ensureAnonymousAuth();

    const afterWorkerRestart = await loadAuthModule(true);
    const afterBrowserRestart = await loadAuthModule(true);

    await expect(afterWorkerRestart.ensureAnonymousAuth()).resolves.toBe(uid);
    await expect(afterBrowserRestart.ensureAnonymousAuth()).resolves.toBe(uid);
    expect(platform.createdUsers).toBe(1);
  });

  it('creates exactly one anonymous user for concurrent first-run requests', async () => {
    const auth = await loadAuthModule(true);
    const results = await Promise.all([
      auth.ensureAnonymousAuth(),
      auth.ensureAnonymousAuth(),
      auth.ensureAnonymousAuth(),
    ]);

    expect(new Set(results).size).toBe(1);
    expect(platform.createdUsers).toBe(1);
  });

  it('does not replace a stored session after a temporary restore failure', async () => {
    platform.credential = 'existing-user';
    platform.mode = 'transient';

    const auth = await loadAuthModule(true);

    await expect(auth.ensureAnonymousAuth()).rejects.toMatchObject({ code: 'restore-failed' });
    expect(platform.createdUsers).toBe(0);
    expect(platform.credential).toBe('existing-user');

    platform.mode = 'ok';

    await expect(auth.ensureAnonymousAuth()).resolves.toBe('existing-user');
    expect(platform.createdUsers).toBe(0);
    expect(platform.app.id).toBe(1);
  });

  it('never silently replaces a revoked session, but allows an explicit reconnect', async () => {
    platform.credential = 'revoked-user';
    platform.mode = 'revoked';

    const auth = await loadAuthModule(true);

    await expect(auth.ensureAnonymousAuth()).rejects.toMatchObject({ code: 'restore-failed' });
    await expect(auth.ensureAnonymousAuth()).rejects.toMatchObject({ code: 'restore-failed' });
    expect(platform.createdUsers).toBe(0);

    await expect(auth.ensureAnonymousAuth({ replaceUnrestorable: true })).resolves.toBe(
      'new-user-1',
    );
    expect(platform.credential).toBe('new-user-1');
  });

  it('fails closed when persistent storage is unavailable', async () => {
    platform.storageAvailable = false;

    const auth = await loadAuthModule(true);

    await expect(auth.ensureAnonymousAuth()).rejects.toMatchObject({ code: 'unavailable' });
    expect(platform.createdUsers).toBe(0);
  });

  it('delegates ID-token refresh to the SDK without changing the user', async () => {
    platform.credential = 'existing-user';

    const auth = await loadAuthModule(true);
    const first = await auth.getFirebaseIdToken();
    const second = await auth.getFirebaseIdToken();

    expect(first).not.toBe(second);
    expect(platform.auths[0]?.currentUser?.uid).toBe('existing-user');
    expect(platform.createdUsers).toBe(0);
  });

  it('never creates users from extension pages and asks the background instead', async () => {
    const auth = await loadAuthModule(false);

    platform.sendMessage.mockImplementation((message: unknown) => {
      expect(message).toEqual({
        replaceUnrestorable: false,
        type: 'firebase-session:ensure',
      });
      platform.credential = 'background-user';

      const pageAuth = platform.auths[0];

      if (pageAuth) {
        pageAuth.currentUser = createUser('background-user');
        pageAuth.listeners.forEach((listener) => listener(pageAuth.currentUser));
      }

      return Promise.resolve({ uid: 'background-user' });
    });

    await expect(auth.ensureAnonymousAuth()).resolves.toBe('background-user');
    expect(platform.createdUsers).toBe(0);
  });

  it('reports a background restore failure to extension pages', async () => {
    const auth = await loadAuthModule(false);

    platform.sendMessage.mockResolvedValue({ error: 'restore-failed' });

    await expect(auth.ensureAnonymousAuth()).rejects.toBeInstanceOf(auth.FirebaseSessionError);
    expect(platform.createdUsers).toBe(0);
  });

  it('deletes the Firebase user and its stored credential on account deletion', async () => {
    platform.credential = 'existing-user';

    const auth = await loadAuthModule(true);

    await auth.ensureAnonymousAuth();
    await auth.deleteFirebaseAccount();

    expect(platform.credential).toBeNull();
  });

  it('validates session messages and responses strictly', async () => {
    const auth = await loadAuthModule(true);

    expect(
      auth.isFirebaseSessionRequest({
        replaceUnrestorable: false,
        type: 'firebase-session:ensure',
      }),
    ).toBe(true);
    expect(auth.isFirebaseSessionRequest({ type: 'firebase-session:ensure' })).toBe(false);
    expect(
      auth.isFirebaseSessionRequest({
        extra: true,
        replaceUnrestorable: true,
        type: 'firebase-session:ensure',
      }),
    ).toBe(false);
    expect(auth.parseFirebaseSessionResponse({ uid: 'bad uid!' })).toEqual({
      error: 'unavailable',
    });
    expect(auth.parseFirebaseSessionResponse(null)).toEqual({ error: 'unavailable' });
  });
});
