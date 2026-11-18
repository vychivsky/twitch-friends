import { browser } from 'wxt/browser';

import {
  ACTIVE_CHANNEL_UPDATE,
  parseTwitchChannel,
  type ActiveChannelUpdate,
  type TwitchChannel,
} from '@/features/presence/twitchChannel';

export const channelAnnouncementInterval = 10_000;

type NavigationTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

function getNavigation(): NavigationTarget | null {
  const navigation = (globalThis as { navigation?: unknown }).navigation;

  return navigation && typeof navigation === 'object' && 'addEventListener' in navigation
    ? (navigation as NavigationTarget)
    : null;
}

export function startTwitchChannelDetection() {
  let previousLogin: string | null | undefined = undefined;
  let stopped = false;

  const sendChannelUpdate = (channel: TwitchChannel | null) => {
    const message: ActiveChannelUpdate = {
      channel,
      detectedAt: Date.now(),
      type: ACTIVE_CHANNEL_UPDATE,
    };

    try {
      browser.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      return;
    }
  };

  const announceChannel = () => {
    if (stopped) {
      return;
    }

    const channel = parseTwitchChannel(window.location.href);

    previousLogin = channel?.login ?? null;
    sendChannelUpdate(channel);
  };

  const updateChannel = () => {
    if (stopped) {
      return;
    }

    const channel = parseTwitchChannel(window.location.href);

    if ((channel?.login ?? null) !== previousLogin) {
      announceChannel();
    }
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      announceChannel();
    }
  };

  const handlePageHide = () => {
    previousLogin = undefined;
    sendChannelUpdate(null);
  };

  const observer = new MutationObserver(updateChannel);
  const navigation = getNavigation();

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  navigation?.addEventListener('currententrychange', updateChannel);
  window.addEventListener('popstate', updateChannel);
  window.addEventListener('focus', announceChannel);
  window.addEventListener('pageshow', announceChannel);
  window.addEventListener('pagehide', handlePageHide);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  const announcementTimer = window.setInterval(announceChannel, channelAnnouncementInterval);

  announceChannel();

  return () => {
    stopped = true;
    observer.disconnect();
    navigation?.removeEventListener('currententrychange', updateChannel);
    window.removeEventListener('popstate', updateChannel);
    window.removeEventListener('focus', announceChannel);
    window.removeEventListener('pageshow', announceChannel);
    window.removeEventListener('pagehide', handlePageHide);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.clearInterval(announcementTimer);
    sendChannelUpdate(null);
  };
}
