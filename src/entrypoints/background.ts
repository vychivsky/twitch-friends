import { getFirebaseEnvironment } from '@/config/firebaseEnvironment';
import { ACTIVE_TAB_STATE_KEY } from '@/features/presence/activeTabState';
import { PresenceTabTracker } from '@/features/presence/presenceTabTracker';
import { isActiveChannelRequest, isActiveChannelUpdate } from '@/features/presence/twitchChannel';
import {
  ensurePresenceFresh,
  getPresenceUid,
  invalidatePresenceRegistration,
  isPresenceStarted,
  refreshPresenceFriends,
  startPresenceSync,
  setPresenceChannel,
} from '@/features/presence/presenceSync';
import { isPresenceFriendsRefreshMessage } from '@/features/presence/presenceMessages';
import {
  isPrivacyConsentAccepted,
  isPrivacyConsentAcceptedMessage,
} from '@/features/privacy/privacyConsent';
import { isAccountSetupRequired } from '@/features/profile/accountState';
import { isTwitchProfileConnectedMessage } from '@/features/profile/myTwitchProfile';
import { BackendError } from '@/infrastructure/backend/backendApi';
import {
  answerFirebaseSessionRequest,
  ensureAnonymousAuth,
  isFirebaseSessionRequest,
  setFirebaseSessionAuthority,
} from '@/infrastructure/firebase/firebaseAuth';
import {
  getRuntimeStatus,
  isRuntimeStatusRequest,
  setRuntimeStatus,
} from '@/runtime/runtimeStatus';
import { getOrCreateLocalIdentity } from '@/security/identity/localIdentity';
import { browser } from 'wxt/browser';

let initializePromise: Promise<void> | null = null;
let presenceStartAttemptAt = 0;
let presenceStartBlocked = false;
const presenceStartRetryInterval = 60_000;
let restoreTabState = Promise.resolve();
const TAB_TRACKER_ALARM = 'presence-tab-tracker';

function reportPresenceError(action: string, cause: unknown) {
  const message = cause instanceof Error ? cause.message : 'Unknown error';

  console.error(`[Twitch Friends] ${action}: ${message}`);
}

async function runInitialization() {
  presenceStartAttemptAt = Date.now();
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
    presenceStartBlocked = true;
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
    presenceStartBlocked = true;
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

function initializeBackground() {
  presenceStartBlocked = false;
  initializePromise ??= runInitialization().finally(() => {
    initializePromise = null;
  });

  return initializePromise;
}

async function startPresenceIfConnected() {
  try {
    await restoreTabState;
    await startPresenceSync();
  } catch (cause) {
    if (cause instanceof BackendError && cause.code === 'failed-precondition') {
      presenceStartBlocked = true;
      return;
    }

    reportPresenceError('Presence could not start', cause);
  }
}

function retryPresenceStart() {
  if (
    isPresenceStarted() ||
    presenceStartBlocked ||
    initializePromise ||
    Date.now() - presenceStartAttemptAt < presenceStartRetryInterval
  ) {
    return;
  }

  void initializeBackground().catch((cause: unknown) =>
    reportPresenceError('Presence initialization failed', cause),
  );
}

async function handleTwitchProfileConnected() {
  await invalidatePresenceRegistration();
  const presenceUid = getPresenceUid();

  if (presenceUid !== null && (await ensureAnonymousAuth()) !== presenceUid) {
    browser.runtime.reload();
    return;
  }

  await initializeBackground();
}
function isExtensionPageSender(sender: { id?: string; tab?: unknown; url?: string }) {
  return (
    sender.id === browser.runtime.id &&
    sender.tab === undefined &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(browser.runtime.getURL('/'))
  );
}

export default defineBackground(() => {
  setFirebaseSessionAuthority();

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
      setPresenceChannel(selection?.channel ?? null);
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
    onUnchanged: () => ensurePresenceFresh(),
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

    if (isFirebaseSessionRequest(message)) {
      if (!isExtensionPageSender(sender)) {
        return false;
      }

      void answerFirebaseSessionRequest(message).then(sendResponse);
      return true;
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
      retryPresenceStart();
    } else if (isActiveChannelRequest(message)) {
      void tracker.getSelection().then((selection) => sendResponse(selection?.channel ?? null));
      return true;
    } else if (isRuntimeStatusRequest(message)) {
      sendResponse(getRuntimeStatus());
    } else if (isPrivacyConsentAcceptedMessage(message)) {
      void initializeBackground();
    } else if (isTwitchProfileConnectedMessage(message)) {
      void handleTwitchProfileConnected().catch((cause: unknown) =>
        reportPresenceError('Connected profile could not initialize', cause),
      );
    } else if (isPresenceFriendsRefreshMessage(message)) {
      void refreshPresenceFriends().catch((cause: unknown) => {
        reportPresenceError('Friends presence could not refresh', cause);
      });
    }

    return false;
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
      retryPresenceStart();
    }
  });

  void initializeBackground();
});
