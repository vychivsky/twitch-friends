import { getFirebaseEnvironment } from '@/config/firebaseEnvironment';
import { LOCAL_FRIENDS_KEY } from '@/features/friends/localFriends';
import { ACTIVE_TAB_STATE_KEY } from '@/features/presence/activeTabState';
import { PresenceTabTracker } from '@/features/presence/presenceTabTracker';
import {
  isActiveChannelRequest,
  isActiveChannelUpdate,
  type TwitchChannel,
} from '@/features/presence/twitchChannel';
import {
  refreshPresenceHeartbeat,
  refreshPresenceFriends,
  startPresenceSync,
  updatePresenceChannel,
} from '@/features/presence/presenceSync';
import { isPresenceFriendsRefreshMessage } from '@/features/presence/presenceMessages';
import {
  isPrivacyConsentAccepted,
  isPrivacyConsentAcceptedMessage,
} from '@/features/privacy/privacyConsent';
import { isAccountSetupRequired } from '@/features/profile/accountState';
import {
  getMyTwitchProfile,
  isTwitchProfileConnectedMessage,
} from '@/features/profile/myTwitchProfile';
import { ensureAnonymousAuth } from '@/infrastructure/firebase/firebaseAuth';
import {
  getRuntimeStatus,
  isRuntimeStatusRequest,
  setRuntimeStatus,
} from '@/runtime/runtimeStatus';
import { getOrCreateLocalIdentity } from '@/security/identity/localIdentity';
import { browser } from 'wxt/browser';

let activeChannel: TwitchChannel | null = null;
let presenceStarted = false;
let presenceStartPromise: Promise<void> | null = null;
let restoreTabState = Promise.resolve();
const TAB_TRACKER_ALARM = 'presence-tab-tracker';

function reportPresenceError(action: string, cause: unknown) {
  const message = cause instanceof Error ? cause.message : 'Unknown error';

  console.error(`[Twitch Friends] ${action}: ${message}`);
}

async function initializeBackground() {
  try {
    const environment = getFirebaseEnvironment();

    setRuntimeStatus({
      environment: environment.useEmulators ? 'emulator' : 'production',
    });
  } catch {
    setRuntimeStatus({
      environment: 'unknown',
    });
  }

  if (!(await isPrivacyConsentAccepted())) {
    setRuntimeStatus({
      firebaseAuth: 'inactive',
      localIdentity: 'inactive',
      privateKeys: 'inactive',
    });
    return;
  }

  setRuntimeStatus({
    firebaseAuth: 'pending',
    localIdentity: 'pending',
    privateKeys: 'pending',
  });

  if (await isAccountSetupRequired()) {
    setRuntimeStatus({
      firebaseAuth: 'inactive',
      localIdentity: 'inactive',
      privateKeys: 'inactive',
    });
    return;
  }

  try {
    await ensureAnonymousAuth();
    setRuntimeStatus({
      firebaseAuth: 'ready',
    });
  } catch {
    setRuntimeStatus({
      firebaseAuth: 'unavailable',
    });
    return;
  }

  try {
    const identity = await getOrCreateLocalIdentity();

    setRuntimeStatus({
      localIdentity: 'ready',
      privateKeys: identity.encryptionPrivateKey.extractable ? 'unavailable' : 'ready',
    });
  } catch {
    setRuntimeStatus({
      localIdentity: 'unavailable',
      privateKeys: 'unavailable',
    });
    return;
  }

  await startPresenceIfConnected();
}

function startPresenceIfConnected() {
  if (presenceStarted) {
    return Promise.resolve();
  }

  presenceStartPromise ??= (async () => {
    try {
      await restoreTabState;
      const profile = await getMyTwitchProfile();

      if (!profile) {
        return;
      }

      await startPresenceSync(activeChannel);
      presenceStarted = true;
    } catch (cause) {
      reportPresenceError('Presence could not start', cause);
      return;
    }
  })().finally(() => {
    presenceStartPromise = null;
  });

  return presenceStartPromise;
}
export default defineBackground(() => {
  let alarmUpdate = Promise.resolve();
  const tracker = new PresenceTabTracker({
    getActiveTabId: async (windowId) => {
      const [tab] = await browser.tabs.query({ active: true, windowId });

      return tab?.id ?? null;
    },
    getFocusedWindowId: async () => {
      const focused = await browser.windows.getLastFocused();

      return focused.id ?? null;
    },
    loadState: async () => {
      const stored: Record<string, unknown> =
        await browser.storage.session.get(ACTIVE_TAB_STATE_KEY);

      return stored[ACTIVE_TAB_STATE_KEY];
    },
    now: () => Date.now(),
    onError: reportPresenceError,
    onSelectionChange: (selection) => {
      activeChannel = selection?.channel ?? null;
      updatePresenceChannel(activeChannel);
      alarmUpdate = alarmUpdate
        .then(async () => {
          if (selection) {
            if (!(await browser.alarms.get(TAB_TRACKER_ALARM))) {
              await browser.alarms.create(TAB_TRACKER_ALARM, { periodInMinutes: 0.5 });
            }
          } else {
            await browser.alarms.clear(TAB_TRACKER_ALARM);
          }
        })
        .catch((cause: unknown) =>
          reportPresenceError('Tab tracker alarm could not update', cause),
        );
    },
    onUnchanged: () => refreshPresenceHeartbeat(),
    saveState: (state) => browser.storage.session.set({ [ACTIVE_TAB_STATE_KEY]: state }),
    tabExists: async (tabId) => {
      try {
        await browser.tabs.get(tabId);
        return true;
      } catch {
        return false;
      }
    },
  });

  restoreTabState = tracker.getSelection().then(() => undefined);

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) {
      return false;
    }

    if (
      isActiveChannelUpdate(message) &&
      typeof sender.tab?.id === 'number' &&
      sender.url?.startsWith('https://www.twitch.tv/')
    ) {
      void tracker.reportChannel({
        active: sender.tab.active,
        channel: message.channel,
        tabId: sender.tab.id,
        windowId: sender.tab.windowId,
      });
    } else if (isActiveChannelRequest(message)) {
      void tracker.getSelection().then((selection) => sendResponse(selection?.channel ?? null));
      return true;
    } else if (isRuntimeStatusRequest(message)) {
      sendResponse(getRuntimeStatus());
    } else if (isPrivacyConsentAcceptedMessage(message)) {
      void initializeBackground();
    } else if (isTwitchProfileConnectedMessage(message)) {
      void startPresenceIfConnected();
    } else if (isPresenceFriendsRefreshMessage(message)) {
      void refreshPresenceFriends().catch((cause: unknown) => {
        reportPresenceError('Friends presence could not refresh', cause);
      });
    }

    return false;
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[LOCAL_FRIENDS_KEY]) {
      void refreshPresenceFriends().catch((cause: unknown) => {
        reportPresenceError('Friends presence could not refresh', cause);
      });
    }
  });

  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    void tracker.activateTab(tabId, windowId);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void tracker.removeTab(tabId);
  });

  browser.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
    void tracker.removeTab(removedTabId);
  });

  browser.windows.onFocusChanged.addListener((windowId) => {
    void tracker.focusWindow(windowId);
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TAB_TRACKER_ALARM) {
      void tracker.heartbeat();
    }
  });

  void initializeBackground();
});
