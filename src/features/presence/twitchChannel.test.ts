import { describe, expect, it } from 'vitest';

import {
  ACTIVE_CHANNEL_UPDATE,
  isActiveChannelUpdate,
  isTwitchChannel,
  parseTwitchChannel,
} from '@/features/presence/twitchChannel';

describe('Twitch channel detection', () => {
  it('finds a channel on a stream page', () => {
    expect(parseTwitchChannel('https://www.twitch.tv/Some_Channel')).toEqual({
      login: 'some_channel',
      url: 'https://www.twitch.tv/some_channel',
    });
  });

  it.each([
    'https://www.twitch.tv/',
    'https://www.twitch.tv/directory',
    'https://www.twitch.tv/following',
    'https://www.twitch.tv/messages',
    'https://www.twitch.tv/popout',
    'https://www.twitch.tv/search',
    'https://www.twitch.tv/videos/123',
    'https://example.com/some_channel',
    'not-a-url',
  ])('ignores non-channel page %s', (url) => {
    expect(parseTwitchChannel(url)).toBeNull();
  });

  it('rejects channel data that does not match its URL', () => {
    expect(
      isTwitchChannel({
        login: 'first_channel',
        url: 'https://www.twitch.tv/second_channel',
      }),
    ).toBe(false);
  });

  it('treats raid and query-string variants as the same channel', () => {
    expect(parseTwitchChannel('https://www.twitch.tv/raided?referrer=raid')?.login).toBe('raided');
  });

  it('accepts channel updates with or without a detection timestamp', () => {
    const channel = { login: 'stream', url: 'https://www.twitch.tv/stream' };

    expect(isActiveChannelUpdate({ channel, type: ACTIVE_CHANNEL_UPDATE })).toBe(true);
    expect(
      isActiveChannelUpdate({ channel: null, detectedAt: 5, type: ACTIVE_CHANNEL_UPDATE }),
    ).toBe(true);
  });

  it('rejects channel updates with unexpected fields or values', () => {
    const channel = { login: 'stream', url: 'https://www.twitch.tv/stream' };

    expect(isActiveChannelUpdate({ channel, detectedAt: 'now', type: ACTIVE_CHANNEL_UPDATE })).toBe(
      false,
    );
    expect(isActiveChannelUpdate({ channel, detectedAt: 1.5, type: ACTIVE_CHANNEL_UPDATE })).toBe(
      false,
    );
    expect(isActiveChannelUpdate({ channel, extra: 1, type: ACTIVE_CHANNEL_UPDATE })).toBe(false);
    expect(
      isActiveChannelUpdate({
        channel: { login: 'stream', url: 'https://evil.test/stream' },
        type: ACTIVE_CHANNEL_UPDATE,
      }),
    ).toBe(false);
  });
});
