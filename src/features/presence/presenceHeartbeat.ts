export const presencePublishMinimumInterval = 25_000;

export const presenceClearDelay = 3_000;

export const presenceRetryDelays = [1_000, 2_000, 5_000, 10_000, 20_000] as const;

export const presenceWriteTimeout = 10_000;

export const presenceHeartbeatAlarmMinutes = 0.5;

export function isPresenceHeartbeatDue(lastPublishedAt: number, now = Date.now()) {
  return now - lastPublishedAt >= presencePublishMinimumInterval;
}
