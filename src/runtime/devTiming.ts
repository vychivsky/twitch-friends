const timingEnabled = import.meta.env.COMMAND === 'serve';

export function logPresenceTiming(stage: string, milliseconds: number, detail = '') {
  if (!timingEnabled) {
    return;
  }

  console.debug(
    `[Twitch Friends][timing] ${stage}: ${Math.round(milliseconds)} ms${detail ? ` (${detail})` : ''}`,
  );
}
