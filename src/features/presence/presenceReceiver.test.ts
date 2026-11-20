import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type FriendPresence } from '@/features/presence/friendPresence';
import { type PresenceRecipient } from '@/features/presence/presencePublisher';
import { PresenceReceiver, type PresenceReceiverDeps } from '@/features/presence/presenceReceiver';

function friend(id: string): PresenceRecipient {
  return {
    encryptionKey: { crv: 'P-256', kty: 'EC', x: 'a'.repeat(43), y: 'b'.repeat(43) },
    id,
    login: id,
  };
}

function record(login: string, expiresAt: number) {
  return {
    ciphertext: `${login}-ciphertext-value`,
    expiresAt,
    iv: 'abcdefghijklmnop',
    version: 1,
  };
}

function createHarness(decode?: PresenceReceiverDeps['decrypt']) {
  const saves: FriendPresence[][] = [];
  const subscriptions: Array<{
    active: boolean;
    emit(records: Record<string, unknown>): void;
    fail(cause: unknown): void;
  }> = [];

  const receiver = new PresenceReceiver({
    clearTimer: (handle) => clearTimeout(handle),
    decrypt:
      decode ??
      ((_friend, presence) => {
        const login = presence.ciphertext.replace('-ciphertext-value', '');

        return Promise.resolve(
          presence.expiresAt > Date.now() ? { login, url: `https://www.twitch.tv/${login}` } : null,
        );
      }),
    now: () => Date.now(),
    save: (items) => {
      saves.push(items);
      return Promise.resolve();
    },
    setTimer: (callback, delay) => setTimeout(callback, delay),
    subscribe: (onRecords, onError) => {
      const subscription = { active: true, emit: onRecords, fail: onError };

      subscriptions.push(subscription);

      return () => {
        subscription.active = false;
      };
    },
  });

  return { receiver, saves, subscriptions };
}

describe('presence receiver', () => {
  it('does not save a record that expires while decryption is pending', async () => {
    const harness = createHarness(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      return { login: 'stream', url: 'https://www.twitch.tv/stream' };
    });

    harness.receiver.setFriends([friend('alice')]);
    harness.receiver.start();
    harness.subscriptions[0]?.emit({ alice: record('stream', Date.now() + 1_000) });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.saves).toEqual([[]]);
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps one subscription when started repeatedly or when friends change', async () => {
    const harness = createHarness();

    harness.receiver.start();
    harness.receiver.start();
    harness.receiver.setFriends([friend('alice')]);
    harness.receiver.setFriends([friend('alice'), friend('bob')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.subscriptions).toHaveLength(1);
  });

  it('does not clear stored presence before the friend list is known', async () => {
    const harness = createHarness();

    harness.receiver.start();
    harness.subscriptions[0]?.emit({ alice: record('stream', Date.now() + 60_000) });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.saves).toEqual([]);

    harness.receiver.setFriends([friend('alice')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.saves.at(-1)?.map((item) => item.channel.login)).toEqual(['stream']);
  });

  it('applies a new snapshot immediately and skips unchanged saves', async () => {
    const harness = createHarness();
    const expiresAt = Date.now() + 60_000;

    harness.receiver.setFriends([friend('alice')]);
    harness.receiver.start();
    harness.subscriptions[0]?.emit({ alice: record('first', expiresAt) });
    await vi.advanceTimersByTimeAsync(0);
    harness.subscriptions[0]?.emit({ alice: record('first', expiresAt) });
    await vi.advanceTimersByTimeAsync(0);
    harness.subscriptions[0]?.emit({ alice: record('second', expiresAt + 1) });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.saves.map((items) => items[0]?.channel.login)).toEqual(['first', 'second']);
  });

  it('keeps presence while friends are refreshed', async () => {
    const harness = createHarness();

    harness.receiver.setFriends([friend('alice')]);
    harness.receiver.start();
    harness.subscriptions[0]?.emit({ alice: record('stream', Date.now() + 60_000) });
    await vi.advanceTimersByTimeAsync(0);
    harness.receiver.setFriends([friend('alice'), friend('bob')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.saves.every((items) => items.length === 1)).toBe(true);
  });

  it('removes presence when the record expires', async () => {
    const harness = createHarness();

    harness.receiver.setFriends([friend('alice')]);
    harness.receiver.start();
    harness.subscriptions[0]?.emit({ alice: record('stream', Date.now() + 1_000) });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_100);

    expect(harness.saves.at(-1)).toEqual([]);
  });

  it('ignores records from people who are not friends', async () => {
    const harness = createHarness();

    harness.receiver.setFriends([friend('alice')]);
    harness.receiver.start();
    harness.subscriptions[0]?.emit({ mallory: record('stream', Date.now() + 60_000) });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.saves.at(-1)).toEqual([]);
  });

  it('resubscribes with backoff after the listener fails', async () => {
    const harness = createHarness();

    harness.receiver.setFriends([friend('alice')]);
    harness.receiver.start();
    harness.subscriptions[0]?.fail(new Error('permission_denied'));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.saves.at(-1)).toEqual([]);
    expect(harness.receiver.isSubscribed()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.subscriptions).toHaveLength(2);
    expect(harness.receiver.isSubscribed()).toBe(true);
  });

  it('unsubscribes and stops timers when stopped', async () => {
    const harness = createHarness();

    harness.receiver.start();
    harness.receiver.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(harness.subscriptions[0]?.active).toBe(false);
    expect(harness.subscriptions).toHaveLength(1);
  });
});
