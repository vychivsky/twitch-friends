import { type FriendPresence } from '@/features/presence/friendPresence';
import { type EncryptedPresence } from '@/features/presence/presenceCrypto';
import { type PresenceRecipient } from '@/features/presence/presencePublisher';
import { type TwitchChannel } from '@/features/presence/twitchChannel';

type TimerHandle = ReturnType<typeof setTimeout>;

export type PresenceReceiverDeps = {
  clearTimer(handle: TimerHandle): void;
  decrypt(friend: PresenceRecipient, presence: EncryptedPresence): Promise<TwitchChannel | null>;
  now(): number;
  onError?(action: string, cause: unknown): void;
  onReceived?(event: { expiresAt: number; friendId: string }): void;
  onUndecryptable?(friendId: string): void;
  save(items: FriendPresence[]): Promise<void>;
  setTimer(callback: () => void, delay: number): TimerHandle;
  subscribe(
    onRecords: (records: Record<string, unknown>) => void,
    onError: (cause: unknown) => void,
  ): () => void;
};

const resubscribeDelays = [2_000, 5_000, 15_000, 60_000] as const;

export function parseEncryptedPresence(value: unknown): EncryptedPresence | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const presence = value as Record<string, unknown>;

  if (
    typeof presence.ciphertext !== 'string' ||
    !/^[A-Za-z0-9_-]{16,512}$/u.test(presence.ciphertext) ||
    typeof presence.expiresAt !== 'number' ||
    !Number.isSafeInteger(presence.expiresAt) ||
    typeof presence.iv !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/u.test(presence.iv) ||
    presence.version !== 1
  ) {
    return null;
  }

  return {
    ciphertext: presence.ciphertext,
    expiresAt: presence.expiresAt,
    iv: presence.iv,
    version: 1,
  };
}

export class PresenceReceiver {
  private expiryHandle: TimerHandle | null = null;
  private friends: PresenceRecipient[] | null = null;
  private lastSaved: string | null = null;
  private saveQueue = Promise.resolve();
  private readonly lastSeenExpiry = new Map<string, number>();
  private records: Record<string, unknown> | null = null;
  private resubscribeAttempt = 0;
  private resubscribeHandle: TimerHandle | null = null;
  private revision = 0;
  private started = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: PresenceReceiverDeps) {}

  start() {
    this.started = true;
    this.subscribe();
  }

  isSubscribed() {
    return this.unsubscribe !== null;
  }

  setFriends(friends: PresenceRecipient[]) {
    this.friends = friends;
    void this.render();
  }

  stop() {
    this.started = false;
    this.revision += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer('expiryHandle');
    this.clearTimer('resubscribeHandle');
  }

  private clearTimer(name: 'expiryHandle' | 'resubscribeHandle') {
    const handle = this[name];

    if (handle !== null) {
      this.deps.clearTimer(handle);
      this[name] = null;
    }
  }

  private subscribe() {
    if (!this.started || this.unsubscribe) {
      return;
    }

    this.clearTimer('resubscribeHandle');

    let active = true;
    const unsubscribe = this.deps.subscribe(
      (records) => {
        if (!active) {
          return;
        }

        this.resubscribeAttempt = 0;
        this.records = records;
        void this.render();
      },
      (cause) => {
        if (!active) {
          return;
        }

        active = false;
        this.unsubscribe = null;
        this.records = null;
        this.revision += 1;
        this.clearTimer('expiryHandle');
        this.deps.onError?.('Friends presence listener failed', cause);
        void this.persist([]);
        this.scheduleResubscribe();
      },
    );

    this.unsubscribe = () => {
      active = false;
      unsubscribe();
    };
  }

  private scheduleResubscribe() {
    if (!this.started || this.resubscribeHandle !== null) {
      return;
    }

    const delay =
      resubscribeDelays[Math.min(this.resubscribeAttempt, resubscribeDelays.length - 1)] ?? 60_000;

    this.resubscribeAttempt += 1;
    this.resubscribeHandle = this.deps.setTimer(() => {
      this.resubscribeHandle = null;
      this.subscribe();
    }, delay);
  }

  private persist(items: FriendPresence[]) {
    this.saveQueue = this.saveQueue.then(async () => {
      const serialized = JSON.stringify(items);

      if (serialized === this.lastSaved) {
        return;
      }

      try {
        await this.deps.save(items);
        this.lastSaved = serialized;
      } catch (cause) {
        this.lastSaved = null;
        this.deps.onError?.('Friends presence could not be saved', cause);
      }
    });

    return this.saveQueue;
  }

  private async render() {
    const friends = this.friends;
    const records = this.records;

    if (!friends || !records) {
      return;
    }

    const revision = ++this.revision;
    let items: FriendPresence[];

    try {
      const decoded = await Promise.all(
        friends.map(async (friend): Promise<FriendPresence | null> => {
          const encrypted = parseEncryptedPresence(records[friend.id]);

          if (!encrypted || encrypted.expiresAt <= this.deps.now()) {
            return null;
          }

          const channel = await this.deps.decrypt(friend, encrypted);

          if (!channel) {
            this.deps.onUndecryptable?.(friend.id);
            return null;
          }

          if (this.lastSeenExpiry.get(friend.id) !== encrypted.expiresAt) {
            this.lastSeenExpiry.set(friend.id, encrypted.expiresAt);
            this.deps.onReceived?.({ expiresAt: encrypted.expiresAt, friendId: friend.id });
          }

          return {
            channel,
            expiresAt: encrypted.expiresAt,
            friendId: friend.id,
            login: friend.login,
          };
        }),
      );

      items = decoded
        .filter((item): item is FriendPresence => item !== null && item.expiresAt > this.deps.now())
        .sort((left, right) => left.friendId.localeCompare(right.friendId));
    } catch (cause) {
      this.deps.onError?.('Friends presence could not be decoded', cause);
      items = [];
    }

    if (revision !== this.revision) {
      return;
    }

    this.scheduleExpiry(items);
    await this.persist(items);
  }

  private scheduleExpiry(items: FriendPresence[]) {
    this.clearTimer('expiryHandle');

    if (items.length === 0) {
      return;
    }

    const earliestExpiry = Math.min(...items.map((item) => item.expiresAt));

    this.expiryHandle = this.deps.setTimer(
      () => {
        this.expiryHandle = null;
        void this.render();
      },
      Math.max(0, earliestExpiry - this.deps.now() + 50),
    );
  }
}
