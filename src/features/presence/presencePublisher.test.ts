import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  presenceClearDelay,
  presencePublishMinimumInterval,
} from '@/features/presence/presenceHeartbeat';
import { PresencePublisher, type PresenceRecipient } from '@/features/presence/presencePublisher';
import { type TwitchChannel } from '@/features/presence/twitchChannel';

function channel(login: string): TwitchChannel {
  return { login, url: `https://www.twitch.tv/${login}` };
}

function recipient(id: string, x = 'a'.repeat(43)): PresenceRecipient {
  return {
    encryptionKey: { crv: 'P-256', kty: 'EC', x, y: 'b'.repeat(43) },
    id,
    login: id,
  };
}

type Deferred = {
  reject(cause: unknown): void;
  resolve(): void;
};

function createHarness() {
  const writes: Array<{ login: string; recipientId: string }> = [];
  const removals: string[] = [];
  const persisted: string[][] = [];
  const pendingWrites: Deferred[] = [];
  let holdWrites = false;
  let failWrites = 0;

  const publisher = new PresencePublisher({
    clearTimer: (handle) => clearTimeout(handle),
    now: () => Date.now(),
    persistPublishedRecipients: (ids) => persisted.push(ids),
    remove: (recipientId) => {
      removals.push(recipientId);
      return Promise.resolve();
    },
    setTimer: (callback, delay) => setTimeout(callback, delay),
    write: async (target, selected, isCurrent) => {
      await Promise.resolve();

      if (!isCurrent()) {
        return false;
      }

      writes.push({ login: selected.login, recipientId: target.id });

      if (failWrites > 0) {
        failWrites -= 1;
        throw new Error('Firebase write failed');
      }

      if (holdWrites) {
        await new Promise<void>((resolve, reject) => {
          pendingWrites.push({ reject, resolve });
        });
      }

      return true;
    },
  });

  return {
    failNextWrites(count: number) {
      failWrites = count;
    },
    hold(value: boolean) {
      holdWrites = value;
    },
    pendingWrites,
    persisted,
    publisher,
    removals,
    writes,
  };
}

describe('presence publisher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes a real channel change immediately without a debounce', async () => {
    const harness = createHarness();

    harness.publisher.setRecipients([recipient('friend-a'), recipient('friend-b')]);
    harness.publisher.setChannel(channel('first'));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.writes).toEqual([
      { login: 'first', recipientId: 'friend-a' },
      { login: 'first', recipientId: 'friend-b' },
    ]);
  });

  it('coalesces rapid A to B to C switching so that C is written last', async () => {
    const harness = createHarness();

    harness.publisher.setRecipients([recipient('friend')]);
    harness.hold(true);
    harness.publisher.setChannel(channel('alpha'));
    await vi.advanceTimersByTimeAsync(0);
    harness.publisher.setChannel(channel('bravo'));
    harness.publisher.setChannel(channel('charlie'));
    harness.hold(false);

    for (const pending of harness.pendingWrites.splice(0)) {
      pending.resolve();
    }

    await harness.publisher.whenIdle();

    expect(harness.writes.map((write) => write.login)).toEqual(['alpha', 'charlie']);
    expect(harness.publisher.getChannel()?.login).toBe('charlie');
  });

  it('skips a stale write whose encryption finished after a newer selection', async () => {
    const harness = createHarness();

    harness.publisher.setRecipients([recipient('friend')]);
    harness.publisher.setChannel(channel('older'));
    harness.publisher.setChannel(channel('newer'));
    await harness.publisher.whenIdle();

    expect(harness.writes.map((write) => write.login)).toEqual(['newer']);
  });

  it('does not write again for duplicate messages about the same channel', async () => {
    const harness = createHarness();

    harness.publisher.setRecipients([recipient('friend')]);
    harness.publisher.setChannel(channel('same'));
    await harness.publisher.whenIdle();

    for (let index = 0; index < 5; index += 1) {
      harness.publisher.setChannel(channel('same'));
      harness.publisher.ensureFresh();
    }

    await harness.publisher.whenIdle();

    expect(harness.writes).toHaveLength(1);
  });

  it('refreshes the record before it expires', async () => {
    const harness = createHarness();

    harness.publisher.setRecipients([recipient('friend')]);
    harness.publisher.setChannel(channel('steady'));
    await harness.publisher.whenIdle();
    await vi.advanceTimersByTimeAsync(presencePublishMinimumInterval);
    await harness.publisher.whenIdle();

    expect(harness.writes).toHaveLength(2);
  });

  it('keeps failed writes unconfirmed and retries them with backoff', async () => {
    const harness = createHarness();

    harness.failNextWrites(1);
    harness.publisher.setRecipients([recipient('friend')]);
    harness.publisher.setChannel(channel('retry'));
    await harness.publisher.whenIdle();

    expect(harness.writes).toHaveLength(1);

    harness.publisher.ensureFresh();
    await harness.publisher.whenIdle();
    expect(harness.writes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await harness.publisher.whenIdle();

    expect(harness.writes).toHaveLength(2);

    harness.publisher.ensureFresh();
    await harness.publisher.whenIdle();
    expect(harness.writes).toHaveLength(2);
  });

  it('removes published records after the clear grace period', async () => {
    const harness = createHarness();

    harness.publisher.setRecipients([recipient('friend')]);
    harness.publisher.setChannel(channel('leaving'));
    await harness.publisher.whenIdle();
    harness.publisher.setChannel(null);
    await vi.advanceTimersByTimeAsync(presenceClearDelay - 1);

    expect(harness.removals).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await harness.publisher.whenIdle();

    expect(harness.removals).toEqual(['friend']);
    expect(harness.persisted.at(-1)).toEqual([]);
  });

  it('keeps presence when a reload re-announces the channel within the grace period', async () => {
    const harness = createHarness();

    harness.publisher.setRecipients([recipient('friend')]);
    harness.publisher.setChannel(channel('reload'));
    await harness.publisher.whenIdle();
    harness.publisher.setChannel(null);
    await vi.advanceTimersByTimeAsync(presenceClearDelay / 2);
    harness.publisher.setChannel(channel('reload'));
    await vi.advanceTimersByTimeAsync(presenceClearDelay);
    await harness.publisher.whenIdle();

    expect(harness.removals).toEqual([]);
  });

  it('cleans up records published by a previous background instance', async () => {
    const harness = createHarness();

    harness.publisher.restorePublishedRecipients(['friend', 'former-friend']);
    harness.publisher.setRecipients([recipient('friend')]);
    harness.publisher.setChannel(null);
    await harness.publisher.whenIdle();

    expect(harness.removals.sort()).toEqual(['former-friend', 'friend']);
  });

  it('removes records for friends that are no longer recipients', async () => {
    const harness = createHarness();

    harness.publisher.setRecipients([recipient('kept'), recipient('removed')]);
    harness.publisher.setChannel(channel('watching'));
    await harness.publisher.whenIdle();
    harness.publisher.setRecipients([recipient('kept')]);
    await harness.publisher.whenIdle();

    expect(harness.removals).toEqual(['removed']);
    expect(harness.writes).toHaveLength(2);
  });

  it('republishes when a recipient rotates their public key', async () => {
    const harness = createHarness();

    harness.publisher.setRecipients([recipient('friend')]);
    harness.publisher.setChannel(channel('watching'));
    await harness.publisher.whenIdle();
    harness.publisher.setRecipients([recipient('friend', 'c'.repeat(43))]);
    await harness.publisher.whenIdle();

    expect(harness.writes).toHaveLength(2);
  });

  it('does nothing until both the channel and recipients are known', async () => {
    const harness = createHarness();

    harness.publisher.restorePublishedRecipients(['friend']);
    harness.publisher.setRecipients([recipient('friend')]);
    await harness.publisher.whenIdle();

    expect(harness.removals).toEqual([]);
    expect(harness.writes).toEqual([]);
  });
});
