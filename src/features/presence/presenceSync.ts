import { onValue, ref, remove, set, type Unsubscribe } from 'firebase/database';
import { browser } from 'wxt/browser';

import { saveFriendPresence } from '@/features/presence/friendPresence';
import {
  decryptPresence,
  encryptPresence,
  presenceLifetime,
} from '@/features/presence/presenceCrypto';
import { presenceWriteTimeout } from '@/features/presence/presenceHeartbeat';
import { PresencePublisher, type PresenceRecipient } from '@/features/presence/presencePublisher';
import { PresenceReceiver } from '@/features/presence/presenceReceiver';
import { normalizeTwitchLogin, type TwitchChannel } from '@/features/presence/twitchChannel';
import { requestBackend } from '@/infrastructure/backend/backendApi';
import { ensureAnonymousAuth } from '@/infrastructure/firebase/firebaseAuth';
import { getFirebaseDatabase } from '@/infrastructure/firebase/firebaseDatabase';
import { logPresenceTiming } from '@/runtime/devTiming';
import { getOrCreateLocalIdentity } from '@/security/identity/localIdentity';
import type { LocalIdentity, PublicIdentityKey } from '@/security/identity/localIdentityTypes';

type FriendsCache = {
  fetchedAt: number;
  friendshipKey: string | null;
  items: PresenceRecipient[];
  uid: string;
  version: 1;
};

export const PRESENCE_FRIENDS_CACHE_KEY = 'presence-friends-cache';
export const PRESENCE_REGISTRATION_KEY = 'presence-identity-registration';
export const PUBLISHED_RECIPIENTS_KEY = 'presence-published-recipients';

const friendsCacheMaxAge = 30 * 60_000;
const friendsRefreshRetryInterval = 5 * 60_000;
const registrationMaxAge = 12 * 60 * 60_000;

let friendsCache: FriendsCache | null = null;
let friendsRefreshAttemptAt = 0;
let identity: LocalIdentity | null = null;
let observedFriendshipKey: string | null = null;
let refreshPending: Promise<void> | null = null;
let refreshRunning: Promise<void> | null = null;
let started = false;
let startPromise: Promise<void> | null = null;
let uid = '';
let unsubscribeFriendships: Unsubscribe | null = null;

function reportPresenceError(action: string, cause: unknown) {
  const message = cause instanceof Error ? cause.message : 'Unknown error';

  console.error(`[Twitch Friends] ${action}: ${message}`);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number) {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new Error('Firebase request timed out.'));
    }, milliseconds);

    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(handle);
        reject(cause instanceof Error ? cause : new Error('Firebase request failed.'));
      },
    );
  });
}

const timers = {
  clearTimer: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  now: () => Date.now(),
  setTimer: (callback: () => void, delay: number) => setTimeout(callback, delay),
};

function presencePath(recipientId: string, senderId: string) {
  return `presence/${recipientId}/${senderId}`;
}

const publisher = new PresencePublisher({
  ...timers,
  onError: reportPresenceError,
  onPublished: ({ channel, latency, recipients }) => {
    logPresenceTiming(
      'channel selection -> Firebase acknowledged',
      latency,
      `${channel?.login ?? 'cleared'}, ${recipients} recipients`,
    );
  },
  persistPublishedRecipients: (recipientIds) => {
    void browser.storage.session
      .set({ [PUBLISHED_RECIPIENTS_KEY]: recipientIds })
      .catch((cause: unknown) => reportPresenceError('Presence state could not be saved', cause));
  },
  remove: async (recipientId) => {
    if (!uid) {
      throw new Error('Presence is not started.');
    }

    await withTimeout(
      remove(ref(getFirebaseDatabase(), presencePath(recipientId, uid))),
      presenceWriteTimeout,
    );
  },
  write: async (recipient, channel, isCurrent) => {
    const localIdentity = identity;

    if (!localIdentity || !uid) {
      throw new Error('Presence is not started.');
    }

    const encrypted = await encryptPresence(localIdentity, recipient.encryptionKey, channel);

    if (!isCurrent()) {
      return false;
    }

    await withTimeout(
      set(ref(getFirebaseDatabase(), presencePath(recipient.id, uid)), encrypted),
      presenceWriteTimeout,
    );

    return true;
  },
});

const receiver = new PresenceReceiver({
  ...timers,
  decrypt: (friend, presence) =>
    identity ? decryptPresence(identity, friend.encryptionKey, presence) : Promise.resolve(null),
  onError: reportPresenceError,
  onReceived: ({ expiresAt, friendId }) => {
    logPresenceTiming(
      'friend write -> local decode',
      Date.now() - (expiresAt - presenceLifetime),
      friendId,
    );
  },
  onUndecryptable: () => {
    refreshFriendsIfAllowed();
  },
  save: saveFriendPresence,
  subscribe: (onRecords, onError) =>
    onValue(
      ref(getFirebaseDatabase(), `presence/${uid}`),
      (snapshot) => {
        const value: unknown = snapshot.val();

        onRecords(value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
      },
      onError,
    ),
});

function parsePublicKey(value: unknown): PublicIdentityKey | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const key = value as Record<string, unknown>;

  if (
    key.crv !== 'P-256' ||
    key.kty !== 'EC' ||
    typeof key.x !== 'string' ||
    typeof key.y !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(key.x) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(key.y)
  ) {
    return null;
  }

  return {
    crv: key.crv,
    kty: key.kty,
    x: key.x,
    y: key.y,
  };
}

function parseRecipient(id: unknown, login: unknown, encryptionKey: unknown) {
  const key = parsePublicKey(encryptionKey);
  const normalizedLogin = typeof login === 'string' ? normalizeTwitchLogin(login) : null;

  if (!key || typeof id !== 'string' || !/^[a-z0-9_-]{1,128}$/iu.test(id) || !normalizedLogin) {
    return null;
  }

  return {
    encryptionKey: key,
    id,
    login: normalizedLogin,
  };
}

export function parsePresenceFriends(value: unknown): PresenceRecipient[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const friend = item as Record<string, unknown>;
    const profile =
      friend.profile && typeof friend.profile === 'object'
        ? (friend.profile as Record<string, unknown>)
        : {};
    const recipient = parseRecipient(friend.id, profile.login, friend.encryptionKey);

    return recipient ? [recipient] : [];
  });
}

export function parseFriendsCache(value: unknown, expectedUid: string): FriendsCache | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const cache = value as Record<string, unknown>;

  if (
    cache.version !== 1 ||
    cache.uid !== expectedUid ||
    typeof cache.fetchedAt !== 'number' ||
    !Number.isSafeInteger(cache.fetchedAt) ||
    (cache.friendshipKey !== null && typeof cache.friendshipKey !== 'string') ||
    !Array.isArray(cache.items)
  ) {
    return null;
  }

  const items: PresenceRecipient[] = [];

  for (const item of cache.items) {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const recipient = parseRecipient(record.id, record.login, record.encryptionKey);

    if (!recipient) {
      return null;
    }

    items.push(recipient);
  }

  return {
    fetchedAt: cache.fetchedAt,
    friendshipKey: cache.friendshipKey,
    items,
    uid: expectedUid,
    version: 1,
  };
}

async function ensureIdentityRegistered(currentUid: string, localIdentity: LocalIdentity) {
  const publicKey = localIdentity.encryptionPublicKey;
  const stored: Record<string, unknown> =
    await browser.storage.local.get(PRESENCE_REGISTRATION_KEY);
  const registration = stored[PRESENCE_REGISTRATION_KEY];
  const record =
    registration && typeof registration === 'object'
      ? (registration as Record<string, unknown>)
      : null;

  if (
    record?.version === 1 &&
    record.uid === currentUid &&
    record.x === publicKey.x &&
    record.y === publicKey.y &&
    typeof record.registeredAt === 'number' &&
    Date.now() - record.registeredAt < registrationMaxAge
  ) {
    return;
  }

  await requestBackend('/api/identity', {
    body: {
      encryptionKey: publicKey,
    },
    method: 'PUT',
  });
  await browser.storage.local.set({
    [PRESENCE_REGISTRATION_KEY]: {
      registeredAt: Date.now(),
      uid: currentUid,
      version: 1,
      x: publicKey.x,
      y: publicKey.y,
    },
  });
}

function applyFriends(items: PresenceRecipient[]) {
  publisher.setRecipients(items);
  receiver.setFriends(items);
}

async function fetchPresenceFriends() {
  if (!uid) {
    return;
  }

  const currentUid = uid;
  const friendshipKey = observedFriendshipKey;

  friendsRefreshAttemptAt = Date.now();

  const items = parsePresenceFriends(await requestBackend<unknown>('/api/presence-friends'));

  if (currentUid !== uid) {
    return;
  }

  friendsCache = {
    fetchedAt: Date.now(),
    friendshipKey,
    items,
    uid: currentUid,
    version: 1,
  };
  applyFriends(items);
  await browser.storage.local.set({ [PRESENCE_FRIENDS_CACHE_KEY]: friendsCache });
}

export function refreshPresenceFriends(): Promise<void> {
  if (!refreshRunning) {
    const run = fetchPresenceFriends().finally(() => {
      refreshRunning = null;
    });

    refreshRunning = run;

    return run;
  }

  refreshPending ??= refreshRunning
    .catch(() => undefined)
    .then(() => {
      refreshPending = null;

      return refreshPresenceFriends();
    });

  return refreshPending;
}

function watchFriendships() {
  if (unsubscribeFriendships || !uid) {
    return;
  }

  unsubscribeFriendships = onValue(
    ref(getFirebaseDatabase(), `friendships/${uid}`),
    (snapshot) => {
      const value: unknown = snapshot.val();

      observedFriendshipKey =
        value && typeof value === 'object' ? Object.keys(value).sort().join(',') : '';

      if (friendsCache?.friendshipKey !== observedFriendshipKey) {
        void refreshPresenceFriends().catch((cause: unknown) => {
          reportPresenceError('Friends presence could not refresh', cause);
        });
      }
    },
    (cause) => {
      unsubscribeFriendships = null;
      reportPresenceError('Friendship listener failed', cause);
    },
  );
}

async function loadPublishedRecipients() {
  try {
    const stored: Record<string, unknown> =
      await browser.storage.session.get(PUBLISHED_RECIPIENTS_KEY);
    const value = stored[PUBLISHED_RECIPIENTS_KEY];

    return Array.isArray(value)
      ? value.filter(
          (item): item is string => typeof item === 'string' && /^[a-z0-9_-]{1,128}$/iu.test(item),
        )
      : [];
  } catch {
    return [];
  }
}

async function startPresence() {
  const currentUid = await ensureAnonymousAuth();
  const localIdentity = await getOrCreateLocalIdentity();

  await ensureIdentityRegistered(currentUid, localIdentity);

  const [stored, publishedRecipients] = await Promise.all([
    browser.storage.local.get(PRESENCE_FRIENDS_CACHE_KEY),
    loadPublishedRecipients(),
  ]);

  uid = currentUid;
  identity = localIdentity;
  friendsCache = parseFriendsCache(stored[PRESENCE_FRIENDS_CACHE_KEY], currentUid);
  publisher.restorePublishedRecipients(publishedRecipients);

  if (!friendsCache) {
    await fetchPresenceFriends();
  } else {
    applyFriends(friendsCache.items);
  }

  receiver.start();
  watchFriendships();
  started = true;

  if (friendsCache && Date.now() - friendsCache.fetchedAt > friendsCacheMaxAge) {
    void refreshPresenceFriends().catch((cause: unknown) => {
      reportPresenceError('Friends presence could not refresh', cause);
    });
  }
}

export function startPresenceSync() {
  if (started) {
    return identity ? ensureIdentityRegistered(uid, identity) : Promise.resolve();
  }

  startPromise ??= startPresence().finally(() => {
    startPromise = null;
  });

  return startPromise;
}

export function isPresenceStarted() {
  return started;
}

export function getPresenceUid() {
  return started ? uid : null;
}

export function setPresenceChannel(channel: TwitchChannel | null) {
  publisher.setChannel(channel);
}

function refreshFriendsIfAllowed() {
  if (!started || Date.now() - friendsRefreshAttemptAt <= friendsRefreshRetryInterval) {
    return;
  }

  friendsRefreshAttemptAt = Date.now();
  void refreshPresenceFriends().catch((cause: unknown) => {
    reportPresenceError('Friends presence could not refresh', cause);
  });
}

export function ensurePresenceFresh() {
  publisher.ensureFresh();

  if (friendsCache && Date.now() - friendsCache.fetchedAt > friendsCacheMaxAge) {
    refreshFriendsIfAllowed();
  }
}

export async function invalidatePresenceRegistration() {
  await browser.storage.local.remove(PRESENCE_REGISTRATION_KEY);
}
