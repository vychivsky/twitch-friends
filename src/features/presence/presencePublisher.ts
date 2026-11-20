import {
  isPresenceHeartbeatDue,
  presenceClearDelay,
  presencePublishMinimumInterval,
  presenceRetryDelays,
} from '@/features/presence/presenceHeartbeat';
import { type TwitchChannel } from '@/features/presence/twitchChannel';
import type { PublicIdentityKey } from '@/security/identity/localIdentityTypes';

export type PresenceRecipient = {
  encryptionKey: PublicIdentityKey;
  id: string;
  login: string;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type PresencePublisherDeps = {
  clearTimer(handle: TimerHandle): void;
  now(): number;
  onError?(action: string, cause: unknown): void;
  onPublished?(event: { channel: TwitchChannel | null; latency: number; recipients: number }): void;

  persistPublishedRecipients?(recipientIds: string[]): void;
  remove(recipientId: string): Promise<void>;
  setTimer(callback: () => void, delay: number): TimerHandle;

  write(
    recipient: PresenceRecipient,
    channel: TwitchChannel,
    isCurrent: () => boolean,
  ): Promise<boolean>;
};

type ConfirmedRecord = {
  at: number;
  login: string;
};

function sameKey(left: PublicIdentityKey, right: PublicIdentityKey) {
  return left.x === right.x && left.y === right.y;
}

export class PresencePublisher {
  private changedAt = 0;
  private clearHandle: TimerHandle | null = null;
  private readonly confirmed = new Map<string, ConfirmedRecord>();
  private desired: TwitchChannel | null | undefined = undefined;
  private dirty = false;
  private generation = 0;
  private readonly pendingRemoval = new Set<string>();
  private readonly published = new Set<string>();
  private recipients: PresenceRecipient[] | null = null;
  private refreshHandle: TimerHandle | null = null;
  private reportedGeneration = -1;
  private retryAttempt = 0;
  private retryHandle: TimerHandle | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: PresencePublisherDeps) {}

  restorePublishedRecipients(recipientIds: string[]) {
    const current = this.recipients ? new Set(this.recipients.map(({ id }) => id)) : null;

    for (const recipientId of recipientIds) {
      this.published.add(recipientId);

      if (current && !current.has(recipientId)) {
        this.pendingRemoval.add(recipientId);
      }
    }

    this.kick();
  }

  setChannel(channel: TwitchChannel | null) {
    const nextLogin = channel?.login ?? null;

    if (this.desired !== undefined && (this.desired?.login ?? null) === nextLogin) {
      this.ensureFresh();
      return;
    }

    const hadChannel = Boolean(this.desired);

    this.desired = channel;
    this.changedAt = this.deps.now();
    this.generation += 1;
    this.cancelTimer('clearHandle');

    if (channel === null && hadChannel) {
      this.clearHandle = this.deps.setTimer(() => {
        this.clearHandle = null;
        this.kick();
      }, presenceClearDelay);
      return;
    }

    this.kick();
  }

  setRecipients(recipients: PresenceRecipient[]) {
    const nextById = new Map(recipients.map((recipient) => [recipient.id, recipient]));

    for (const recipientId of this.published) {
      if (!nextById.has(recipientId)) {
        this.pendingRemoval.add(recipientId);
      }
    }

    for (const recipient of this.recipients ?? []) {
      const next = nextById.get(recipient.id);

      if (!next || !sameKey(next.encryptionKey, recipient.encryptionKey)) {
        this.confirmed.delete(recipient.id);
      }
    }

    for (const recipientId of nextById.keys()) {
      this.pendingRemoval.delete(recipientId);
    }

    this.recipients = recipients;
    this.generation += 1;
    this.kick();
  }

  ensureFresh() {
    if (this.retryHandle === null && this.hasWork(this.deps.now())) {
      this.kick();
    }
  }

  getChannel() {
    return this.desired ?? null;
  }

  stop() {
    this.stopped = true;
    this.cancelTimer('clearHandle');
    this.cancelTimer('refreshHandle');
    this.cancelTimer('retryHandle');
  }

  async whenIdle() {
    while (this.running) {
      await this.running;
    }
  }

  private cancelTimer(name: 'clearHandle' | 'refreshHandle' | 'retryHandle') {
    const handle = this[name];

    if (handle !== null) {
      this.deps.clearTimer(handle);
      this[name] = null;
    }
  }

  private isReady() {
    return !this.stopped && this.recipients !== null && this.desired !== undefined;
  }

  private dueWrites(now: number) {
    const channel = this.desired;

    if (!channel || !this.recipients) {
      return [];
    }

    return this.recipients.filter((recipient) => {
      const record = this.confirmed.get(recipient.id);

      return !record || record.login !== channel.login || isPresenceHeartbeatDue(record.at, now);
    });
  }

  private dueRemovals() {
    if (this.desired === null && this.clearHandle === null) {
      return [...new Set([...this.published, ...this.pendingRemoval])];
    }

    return [...this.pendingRemoval];
  }

  private hasWork(now: number) {
    return this.isReady() && (this.dueWrites(now).length > 0 || this.dueRemovals().length > 0);
  }

  private kick() {
    if (!this.isReady()) {
      return;
    }

    if (this.running) {
      this.dirty = true;
      return;
    }

    const run = this.runPasses().finally(() => {
      if (this.running === run) {
        this.running = null;
      }
    });

    this.running = run;
  }

  private async runPasses() {
    do {
      this.dirty = false;
      await this.publishPass();
    } while (this.dirty && this.isReady());
  }

  private persistPublished() {
    this.deps.persistPublishedRecipients?.([...this.published].sort());
  }

  private async publishPass() {
    if (!this.isReady()) {
      return;
    }

    const generation = this.generation;
    const channel = this.desired ?? null;
    const startedAt = this.deps.now();
    const writes = this.dueWrites(startedAt);
    const removals = this.dueRemovals();
    let failed = false;

    if (writes.length > 0 || removals.length > 0) {
      const publishedBefore = this.published.size;

      for (const recipient of writes) {
        this.published.add(recipient.id);
      }

      if (this.published.size !== publishedBefore) {
        this.persistPublished();
      }

      const isCurrent = () => !this.stopped && generation === this.generation;
      const [writeResults, removalResults] = await Promise.all([
        Promise.allSettled(
          writes.map((recipient) =>
            channel ? this.deps.write(recipient, channel, isCurrent) : Promise.resolve(false),
          ),
        ),
        Promise.allSettled(removals.map((recipientId) => this.deps.remove(recipientId))),
      ]);
      let publishedChanged = false;

      writeResults.forEach((result, index) => {
        const recipient = writes[index];

        if (!recipient || !channel) {
          return;
        }

        if (result.status === 'rejected') {
          failed = true;
          this.confirmed.delete(recipient.id);
          this.deps.onError?.('Presence update failed', result.reason);
        } else if (result.value) {
          this.confirmed.set(recipient.id, { at: startedAt, login: channel.login });
        }
      });

      removalResults.forEach((result, index) => {
        const recipientId = removals[index];

        if (recipientId === undefined) {
          return;
        }

        if (result.status === 'rejected') {
          failed = true;
          this.deps.onError?.('Presence removal failed', result.reason);
          return;
        }

        this.confirmed.delete(recipientId);
        this.pendingRemoval.delete(recipientId);
        publishedChanged = this.published.delete(recipientId) || publishedChanged;
      });

      if (publishedChanged) {
        this.persistPublished();
      }
    }

    if (this.stopped) {
      return;
    }

    if (failed) {
      this.scheduleRetry();
    } else {
      this.retryAttempt = 0;
      this.cancelTimer('retryHandle');
    }

    if (
      !failed &&
      generation === this.generation &&
      this.reportedGeneration !== generation &&
      !this.hasWork(this.deps.now())
    ) {
      this.reportedGeneration = generation;
      this.deps.onPublished?.({
        channel,
        latency: this.deps.now() - this.changedAt,
        recipients: this.recipients?.length ?? 0,
      });
    }

    this.scheduleRefresh();
  }

  private scheduleRetry() {
    if (this.retryHandle !== null) {
      return;
    }

    const delay =
      presenceRetryDelays[Math.min(this.retryAttempt, presenceRetryDelays.length - 1)] ?? 20_000;

    this.retryAttempt += 1;
    this.retryHandle = this.deps.setTimer(() => {
      this.retryHandle = null;
      this.kick();
    }, delay);
  }

  private scheduleRefresh() {
    this.cancelTimer('refreshHandle');

    const channel = this.desired;

    if (!channel || !this.recipients) {
      return;
    }

    const confirmedTimes = this.recipients.flatMap((recipient) => {
      const record = this.confirmed.get(recipient.id);

      return record?.login === channel.login ? [record.at] : [];
    });

    if (confirmedTimes.length === 0) {
      return;
    }

    const delay = Math.max(
      0,
      Math.min(...confirmedTimes) + presencePublishMinimumInterval - this.deps.now(),
    );

    this.refreshHandle = this.deps.setTimer(() => {
      this.refreshHandle = null;
      this.ensureFresh();
    }, delay);
  }
}
