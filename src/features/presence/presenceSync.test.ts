import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ValueListener = (snapshot: { val(): unknown }) => void;

const env = vi.hoisted(() => ({
  backendCalls: [] as string[],
  friendshipListeners: [] as ValueListener[],
  inboxListeners: [] as ValueListener[],
  local: new Map<string, unknown>(),
  presenceFriends: [] as unknown[],
  session: new Map<string, unknown>(),
  setCalls: [] as string[],
  setFailures: 0,
}));

function storageArea(map: Map<string, unknown>) {
  return {
    get: (key: string) => Promise.resolve(map.has(key) ? { [key]: map.get(key) } : {}),
    remove: (key: string) => {
      map.delete(key);
      return Promise.resolve();
    },
    set: (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) {
        map.set(key, structuredClone(value));
      }

      return Promise.resolve();
    },
  };
}

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: storageArea(env.local),
      session: storageArea(env.session),
    },
  },
}));

vi.mock('firebase/database', () => ({
  onValue: (reference: { path: string }, listener: ValueListener) => {
    if (reference.path.startsWith('friendships/')) {
      env.friendshipListeners.push(listener);
    } else {
      env.inboxListeners.push(listener);
    }

    return () => undefined;
  },
  ref: (_database: unknown, path: string) => ({ path }),
  remove: () => Promise.resolve(),
  set: (reference: { path: string }) => {
    env.setCalls.push(reference.path);

    if (env.setFailures > 0) {
      env.setFailures -= 1;
      return Promise.reject(new Error('PERMISSION_DENIED'));
    }

    return Promise.resolve();
  },
}));

vi.mock('@/infrastructure/backend/backendApi', () => ({
  requestBackend: (path: string) => {
    env.backendCalls.push(path);

    return Promise.resolve(
      path === '/api/presence-friends' ? env.presenceFriends : { success: true },
    );
  },
}));

vi.mock('@/infrastructure/firebase/firebaseAuth', () => ({
  ensureAnonymousAuth: () => Promise.resolve('me'),
}));

vi.mock('@/infrastructure/firebase/firebaseDatabase', () => ({
  getFirebaseDatabase: () => ({}),
}));

vi.mock('@/security/identity/localIdentity', () => ({
  getOrCreateLocalIdentity: () =>
    Promise.resolve({
      createdAt: 1,
      encryptionPrivateKey: {},
      encryptionPublicKey: { crv: 'P-256', kty: 'EC', x: 'x'.repeat(43), y: 'y'.repeat(43) },
      version: 1,
    }),
}));

vi.mock('@/features/presence/presenceCrypto', () => ({
  decryptPresence: () => Promise.resolve(null),
  encryptPresence: () =>
    Promise.resolve({
      ciphertext: 'c'.repeat(32),
      expiresAt: Date.now() + 60_000,
      iv: 'i'.repeat(16),
      version: 1,
    }),
  presenceLifetime: 60_000,
}));

vi.mock('@/features/presence/friendPresence', () => ({
  saveFriendPresence: () => Promise.resolve(),
}));

function friend(id: string) {
  return {
    encryptionKey: { crv: 'P-256', kty: 'EC', x: 'a'.repeat(43), y: 'b'.repeat(43) },
    id,
    profile: { login: id },
  };
}

async function loadPresenceSync() {
  vi.resetModules();

  return import('@/features/presence/presenceSync');
}

function emitFriendships(ids: string[]) {
  const value = Object.fromEntries(ids.map((id) => [id, true]));

  for (const listener of env.friendshipListeners) {
    listener({ val: () => (ids.length > 0 ? value : null) });
  }
}

const watching = { login: 'stream', url: 'https://www.twitch.tv/stream' };

describe('presence synchronization', () => {
  it('registers the identity again after explicit invalidation', async () => {
    const sync = await loadPresenceSync();

    await sync.startPresenceSync();
    env.backendCalls = [];
    await sync.invalidatePresenceRegistration();
    await sync.startPresenceSync();

    expect(env.backendCalls).toEqual(['/api/identity']);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    env.backendCalls = [];
    env.friendshipListeners = [];
    env.inboxListeners = [];
    env.local.clear();
    env.presenceFriends = [friend('alice')];
    env.session.clear();
    env.setCalls = [];
    env.setFailures = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts once and publishes immediately after the first start', async () => {
    const sync = await loadPresenceSync();

    sync.setPresenceChannel(watching);
    await Promise.all([sync.startPresenceSync(), sync.startPresenceSync()]);
    await vi.advanceTimersByTimeAsync(0);

    expect(env.backendCalls).toEqual(['/api/identity', '/api/presence-friends']);
    expect(env.setCalls).toEqual(['presence/alice/me']);
    expect(env.inboxListeners).toHaveLength(1);
  });

  it('restarts from cached registration and friends without calling the Worker', async () => {
    const firstRun = await loadPresenceSync();

    await firstRun.startPresenceSync();
    emitFriendships(['alice']);
    await vi.advanceTimersByTimeAsync(0);
    env.backendCalls = [];
    env.setCalls = [];
    env.friendshipListeners = [];

    const restarted = await loadPresenceSync();

    restarted.setPresenceChannel(watching);
    await restarted.startPresenceSync();
    emitFriendships(['alice']);
    await vi.advanceTimersByTimeAsync(0);

    expect(env.backendCalls).toEqual([]);
    expect(env.setCalls).toEqual(['presence/alice/me']);
  });

  it('refreshes recipients when the server-managed friendship node changes', async () => {
    const sync = await loadPresenceSync();

    sync.setPresenceChannel(watching);
    await sync.startPresenceSync();
    emitFriendships(['alice']);
    await vi.advanceTimersByTimeAsync(0);
    env.backendCalls = [];
    env.presenceFriends = [friend('alice'), friend('bob')];
    emitFriendships(['alice', 'bob']);
    await vi.advanceTimersByTimeAsync(0);

    expect(env.backendCalls).toEqual(['/api/presence-friends']);
    expect(env.setCalls).toContain('presence/bob/me');
  });

  it('runs one more refresh when asked during a running refresh', async () => {
    const sync = await loadPresenceSync();

    await sync.startPresenceSync();
    env.backendCalls = [];

    await Promise.all([
      sync.refreshPresenceFriends(),
      sync.refreshPresenceFriends(),
      sync.refreshPresenceFriends(),
    ]);

    expect(env.backendCalls).toEqual(['/api/presence-friends', '/api/presence-friends']);
  });

  it('retries a rejected Firebase write instead of recording it as published', async () => {
    const sync = await loadPresenceSync();

    env.setFailures = 1;
    sync.setPresenceChannel(watching);
    await sync.startPresenceSync();
    await vi.advanceTimersByTimeAsync(0);

    expect(env.setCalls).toEqual(['presence/alice/me']);

    sync.ensurePresenceFresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.setCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(env.setCalls).toEqual(['presence/alice/me', 'presence/alice/me']);
  });

  it('persists only friend identifiers for cleanup, never the watched channel', async () => {
    const sync = await loadPresenceSync();

    sync.setPresenceChannel(watching);
    await sync.startPresenceSync();
    await vi.advanceTimersByTimeAsync(0);

    expect(env.session.get('presence-published-recipients')).toEqual(['alice']);
    expect(JSON.stringify([...env.local.values(), ...env.session.values()])).not.toContain(
      'stream',
    );
  });

  it('rejects a cache that belongs to another Firebase user', async () => {
    const sync = await loadPresenceSync();

    expect(
      sync.parseFriendsCache(
        { fetchedAt: 1, friendshipKey: null, items: [], uid: 'someone-else', version: 1 },
        'me',
      ),
    ).toBeNull();
    expect(
      sync.parseFriendsCache(
        { fetchedAt: 1, friendshipKey: null, items: [{ id: '../x' }], uid: 'me', version: 1 },
        'me',
      ),
    ).toBeNull();
  });
});
