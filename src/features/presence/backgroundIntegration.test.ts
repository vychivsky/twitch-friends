import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_CHANNEL_GET } from '@/features/presence/twitchChannel';

type Sender = {
  id?: string;
  tab?: { active: boolean; id: number; windowId: number };
  url?: string;
};

type MessageListener = (
  message: unknown,
  sender: Sender,
  respond: (response: unknown) => void,
) => boolean;

const platform = vi.hoisted(() => ({
  answerSession: vi.fn(() => Promise.resolve({ uid: 'existing-user' })),
  auth: vi.fn(() => Promise.resolve('existing-user')),
  consent: false,
  onMessage: vi.fn<(listener: MessageListener) => void>(),
  sessionAuthority: vi.fn(),
  startPresence: vi.fn(() => Promise.resolve()),
  storedTabs: vi.fn<() => unknown>(() => undefined),
  updateChannel: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    alarms: {
      clear: vi.fn(() => Promise.resolve(true)),
      create: vi.fn(() => Promise.resolve()),
      get: vi.fn(() => Promise.resolve(undefined)),
      onAlarm: { addListener: vi.fn() },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://extension-id${path}`,
      id: 'extension-id',
      onMessage: { addListener: platform.onMessage },
    },
    storage: {
      onChanged: { addListener: vi.fn() },
      session: {
        get: (key: string) => Promise.resolve({ [key]: platform.storedTabs() }),
        set: vi.fn(() => Promise.resolve()),
      },
    },
    tabs: {
      get: vi.fn(() => Promise.resolve({ id: 1 })),
      onActivated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onReplaced: { addListener: vi.fn() },
      query: vi.fn(() => Promise.resolve([{ id: 1 }])),
    },
    windows: {
      getLastFocused: vi.fn(() => Promise.resolve({ id: 1 })),
      onFocusChanged: { addListener: vi.fn() },
    },
  },
}));

vi.mock('@/config/firebaseEnvironment', () => ({
  getFirebaseEnvironment: () => ({ useEmulators: true }),
}));
vi.mock('@/features/friends/localFriends', () => ({ LOCAL_FRIENDS_KEY: 'local-friends' }));
vi.mock('@/features/privacy/privacyConsent', () => ({
  isPrivacyConsentAccepted: () => Promise.resolve(platform.consent),
  isPrivacyConsentAcceptedMessage: () => false,
}));
vi.mock('@/features/profile/accountState', () => ({
  isAccountSetupRequired: () => Promise.resolve(false),
}));
vi.mock('@/features/profile/myTwitchProfile', () => ({
  getMyTwitchProfile: () => Promise.resolve({ login: 'viewer' }),
  isTwitchProfileConnectedMessage: () => false,
}));
vi.mock('@/infrastructure/firebase/firebaseAuth', () => ({
  answerFirebaseSessionRequest: platform.answerSession,
  ensureAnonymousAuth: platform.auth,
  isFirebaseSessionRequest: (value: unknown) =>
    typeof value === 'object' && value !== null && 'replaceUnrestorable' in value,
  setFirebaseSessionAuthority: platform.sessionAuthority,
}));
vi.mock('@/features/presence/presenceSync', () => ({
  ensurePresenceFresh: vi.fn(),
  getPresenceUid: () => null,
  invalidatePresenceRegistration: () => Promise.resolve(),
  isPresenceStarted: () => false,
  refreshPresenceFriends: () => Promise.resolve(),
  startPresenceSync: platform.startPresence,
  setPresenceChannel: platform.updateChannel,
}));
vi.mock('@/security/identity/localIdentity', () => ({
  getOrCreateLocalIdentity: () => Promise.resolve({ encryptionPrivateKey: { extractable: false } }),
}));
vi.mock('@/runtime/runtimeStatus', () => ({
  getRuntimeStatus: () => ({}),
  isRuntimeStatusRequest: () => false,
  setRuntimeStatus: vi.fn(),
}));

async function boot() {
  await import('@/entrypoints/background');
  await vi.advanceTimersByTimeAsync(0);
  const listener = platform.onMessage.mock.calls[0]?.[0];

  if (!listener) {
    throw new Error('Background message listener was not registered.');
  }

  return listener;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  platform.consent = false;
  platform.storedTabs.mockReturnValue(undefined);
  vi.stubGlobal('defineBackground', (main: () => void) => {
    main();
    return {};
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('background session and tab integration', () => {
  it('retries a failed initialization on a channel report after the retry interval', async () => {
    platform.consent = true;
    platform.auth.mockRejectedValueOnce(new Error('Temporary auth failure'));
    const listener = await boot();
    const sender = {
      id: 'extension-id',
      tab: { active: true, id: 1, windowId: 1 },
      url: 'https://www.twitch.tv/stream',
    };
    const message = {
      channel: { login: 'stream', url: 'https://www.twitch.tv/stream' },
      type: 'active-channel:update',
    };

    listener(message, sender, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(platform.auth).toHaveBeenCalledOnce();
    expect(platform.startPresence).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    listener(message, sender, vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(platform.auth).toHaveBeenCalledTimes(2);
    expect(platform.startPresence).toHaveBeenCalledOnce();
  });

  it('establishes background session authority without authenticating before consent', async () => {
    await boot();

    expect(platform.sessionAuthority).toHaveBeenCalledOnce();
    expect(platform.auth).not.toHaveBeenCalled();
    expect(platform.startPresence).not.toHaveBeenCalled();
  });

  it.each<Sender>([
    { id: 'other-extension', url: 'chrome-extension://extension-id/popup.html' },
    { id: 'extension-id', url: 'https://www.twitch.tv/stream' },
    { id: 'extension-id' },
    {
      id: 'extension-id',
      tab: { active: true, id: 1, windowId: 1 },
      url: 'chrome-extension://extension-id/popup.html',
    },
  ])('rejects session requests from an untrusted sender %#', async (sender) => {
    const listener = await boot();
    const respond = vi.fn();

    expect(listener({ replaceUnrestorable: false }, sender, respond)).toBe(false);
    expect(platform.answerSession).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('answers session requests from the extension popup', async () => {
    const listener = await boot();
    const respond = vi.fn();
    const request = { replaceUnrestorable: false };

    expect(
      listener(
        request,
        { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' },
        respond,
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(platform.answerSession).toHaveBeenCalledWith(request);
    expect(respond).toHaveBeenCalledWith({ uid: 'existing-user' });
  });

  it('restores a tab before starting presence after consent', async () => {
    platform.consent = true;
    platform.storedTabs.mockReturnValue({
      focusedWindowId: 1,
      tabs: [
        { activatedAt: Date.now(), login: 'stream', reportedAt: Date.now(), tabId: 1, windowId: 1 },
      ],
      version: 1,
    });
    const listener = await boot();
    const respond = vi.fn();

    expect(platform.updateChannel).toHaveBeenCalledWith({
      login: 'stream',
      url: 'https://www.twitch.tv/stream',
    });
    expect(platform.startPresence).toHaveBeenCalledOnce();
    expect(platform.updateChannel.mock.invocationCallOrder[0]).toBeLessThan(
      platform.startPresence.mock.invocationCallOrder[0] ?? 0,
    );
    expect(listener({ type: ACTIVE_CHANNEL_GET }, { id: 'extension-id' }, respond)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(respond).toHaveBeenCalledWith({ login: 'stream', url: 'https://www.twitch.tv/stream' });
  });
});
