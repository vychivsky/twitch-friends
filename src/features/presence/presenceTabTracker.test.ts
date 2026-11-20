import { describe, expect, it, vi } from 'vitest';

import {
  createActiveTabState,
  parseActiveTabState,
  recordTabReport,
  selectPresenceTab,
  tabReportLease,
  type PresenceTabSelection,
  type StoredActiveTabState,
} from '@/features/presence/activeTabState';
import { PresenceTabTracker } from '@/features/presence/presenceTabTracker';
import { type TwitchChannel } from '@/features/presence/twitchChannel';

function channel(login: string): TwitchChannel {
  return { login, url: `https://www.twitch.tv/${login}` };
}

type TrackerOptions = {
  activeTabs?: Array<[number, number]>;
  focusedWindowId?: number | null;
  openTabs?: number[];
  stored?: unknown;
};

function createTracker(options: TrackerOptions = {}) {
  let now = 1_000_000;
  let stored: unknown = options.stored;
  const openTabs = new Set(options.openTabs ?? []);
  const selections: Array<string | null> = [];
  const activeTabs = new Map<number, number>(options.activeTabs);

  const tracker = new PresenceTabTracker({
    getActiveTabId: (windowId) => Promise.resolve(activeTabs.get(windowId) ?? null),
    getFocusedWindowId: () => Promise.resolve(options.focusedWindowId ?? 1),
    loadState: () => Promise.resolve(stored),
    now: () => now,
    onSelectionChange: (selection: PresenceTabSelection | null) => {
      selections.push(selection?.channel.login ?? null);
    },
    saveState: (state: StoredActiveTabState) => {
      stored = state;
      return Promise.resolve();
    },
    tabExists: (tabId) => Promise.resolve(openTabs.has(tabId)),
  });

  return {
    activeTabs,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    openTabs,
    selections,
    stored: () => stored,
    tracker,
  };
}

describe('active Twitch tab selection', () => {
  it('ignores tab activation in a window that does not have focus', async () => {
    const harness = createTracker();

    await harness.tracker.reportChannel({
      active: true,
      channel: channel('focused'),
      tabId: 1,
      windowId: 1,
    });
    await harness.tracker.reportChannel({
      active: false,
      channel: channel('other'),
      tabId: 2,
      windowId: 2,
    });
    harness.advance(1_000);
    await harness.tracker.activateTab(2, 2);

    expect(harness.selections).toEqual([null, 'focused']);
  });

  it('restores the active tab in the currently focused window', async () => {
    const harness = createTracker({
      activeTabs: [[2, 2]],
      focusedWindowId: 2,
      openTabs: [1, 2],
      stored: {
        focusedWindowId: 1,
        tabs: [
          { activatedAt: 999_000, login: 'old', reportedAt: 999_000, tabId: 1, windowId: 1 },
          { activatedAt: 998_000, login: 'current', reportedAt: 999_000, tabId: 2, windowId: 2 },
        ],
        version: 1,
      },
    });

    await expect(harness.tracker.getSelection()).resolves.toMatchObject({ tabId: 2 });
    expect(harness.selections).toEqual(['current']);
  });

  it('lets the foreground tab control presence and ignores background reports', async () => {
    const harness = createTracker();

    await harness.tracker.reportChannel({
      active: true,
      channel: channel('front'),
      tabId: 1,
      windowId: 1,
    });
    await harness.tracker.reportChannel({
      active: false,
      channel: channel('back'),
      tabId: 2,
      windowId: 1,
    });

    expect(harness.selections).toEqual([null, 'front']);
  });

  it('switches to another Twitch tab when the user activates it', async () => {
    const harness = createTracker();

    await harness.tracker.reportChannel({
      active: true,
      channel: channel('first'),
      tabId: 1,
      windowId: 1,
    });
    await harness.tracker.reportChannel({
      active: false,
      channel: channel('second'),
      tabId: 2,
      windowId: 1,
    });
    harness.advance(1_000);
    await harness.tracker.activateTab(2, 1);

    expect(harness.selections.at(-1)).toBe('second');
  });

  it('does not flip between active tabs in two windows', async () => {
    const harness = createTracker({ focusedWindowId: 1 });

    for (let round = 0; round < 3; round += 1) {
      harness.advance(10_000);
      await harness.tracker.reportChannel({
        active: true,
        channel: channel('focused'),
        tabId: 1,
        windowId: 1,
      });
      harness.advance(10);
      await harness.tracker.reportChannel({
        active: true,
        channel: channel('other-window'),
        tabId: 2,
        windowId: 2,
      });
    }

    expect(harness.selections).toEqual([null, 'focused']);

    harness.activeTabs.set(2, 2);
    harness.advance(1_000);
    await harness.tracker.focusWindow(2);

    expect(harness.selections.at(-1)).toBe('other-window');
  });

  it('keeps the selection when the browser loses focus to another application', async () => {
    const harness = createTracker();

    await harness.tracker.reportChannel({
      active: true,
      channel: channel('watching'),
      tabId: 1,
      windowId: 1,
    });
    await harness.tracker.focusWindow(-1);

    expect(harness.selections).toEqual([null, 'watching']);
  });

  it('falls back to another Twitch tab when the active tab closes', async () => {
    const harness = createTracker();

    await harness.tracker.reportChannel({
      active: false,
      channel: channel('fallback'),
      tabId: 2,
      windowId: 1,
    });
    harness.advance(1_000);
    await harness.tracker.reportChannel({
      active: true,
      channel: channel('primary'),
      tabId: 1,
      windowId: 1,
    });
    await harness.tracker.removeTab(1);

    expect(harness.selections).toEqual([null, 'fallback', 'primary', 'fallback']);

    await harness.tracker.removeTab(2);

    expect(harness.selections.at(-1)).toBeNull();
  });

  it('follows a channel change inside the selected tab', async () => {
    const harness = createTracker();

    for (const login of ['alpha', 'bravo', 'charlie']) {
      await harness.tracker.reportChannel({
        active: true,
        channel: channel(login),
        tabId: 1,
        windowId: 1,
      });
    }

    expect(harness.selections).toEqual([null, 'alpha', 'bravo', 'charlie']);
  });

  it('drops a tab whose content script stopped reporting', async () => {
    const harness = createTracker();

    await harness.tracker.reportChannel({
      active: true,
      channel: channel('gone'),
      tabId: 1,
      windowId: 1,
    });
    harness.advance(tabReportLease + 1);
    await harness.tracker.heartbeat();

    expect(harness.selections.at(-1)).toBeNull();
  });

  it('restores the selection after a service-worker restart before emitting', async () => {
    const first = createTracker({ openTabs: [1, 2] });

    await first.tracker.reportChannel({
      active: false,
      channel: channel('background'),
      tabId: 2,
      windowId: 1,
    });
    await first.tracker.reportChannel({
      active: true,
      channel: channel('restored'),
      tabId: 1,
      windowId: 1,
    });

    const restarted = createTracker({ openTabs: [2], stored: first.stored() });

    await expect(restarted.tracker.getSelection()).resolves.toMatchObject({
      channel: { login: 'background' },
      tabId: 2,
    });
    expect(restarted.selections).toEqual(['background']);
  });

  it('ignores corrupted persisted state', async () => {
    const harness = createTracker({
      stored: { tabs: [{ login: '../evil', tabId: 'x' }], version: 1 },
    });

    await expect(harness.tracker.getSelection()).resolves.toBeNull();
    expect(parseActiveTabState('not an object').tabs.size).toBe(0);
    expect(parseActiveTabState({ tabs: [], version: 99 }).tabs.size).toBe(0);
  });

  it('serializes all events in order', async () => {
    const harness = createTracker();
    const pending = [
      harness.tracker.reportChannel({ active: true, channel: channel('a'), tabId: 1, windowId: 1 }),
      harness.tracker.reportChannel({ active: true, channel: channel('b'), tabId: 1, windowId: 1 }),
      harness.tracker.reportChannel({ active: true, channel: channel('c'), tabId: 1, windowId: 1 }),
    ];

    await Promise.all(pending);

    expect(harness.selections.at(-1)).toBe('c');
  });

  it('breaks selection ties deterministically', () => {
    let state = createActiveTabState();

    state = recordTabReport(state, {
      active: false,
      channel: channel('low'),
      now: 5,
      tabId: 3,
      windowId: 1,
    });
    state = recordTabReport(state, {
      active: false,
      channel: channel('high'),
      now: 5,
      tabId: 9,
      windowId: 1,
    });

    expect(selectPresenceTab(state)?.tabId).toBe(9);
  });

  it('does not persist report timestamps on every heartbeat', async () => {
    const saveState = vi.fn(() => Promise.resolve());
    let now = 0;
    const tracker = new PresenceTabTracker({
      getActiveTabId: () => Promise.resolve(null),
      getFocusedWindowId: () => Promise.resolve(1),
      loadState: () => Promise.resolve(undefined),
      now: () => now,
      onSelectionChange: () => undefined,
      saveState,
      tabExists: () => Promise.resolve(true),
    });

    for (let index = 0; index < 5; index += 1) {
      now += 1_000;
      await tracker.reportChannel({ active: true, channel: channel('x'), tabId: 1, windowId: 1 });
    }

    expect(saveState.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
