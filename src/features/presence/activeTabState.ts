import { parseTwitchChannel, type TwitchChannel } from '@/features/presence/twitchChannel';

export type TrackedTab = {
  activatedAt: number;
  channel: TwitchChannel | null;
  reportedAt: number;
  windowId: number;
};

export type ActiveTabState = {
  focusedWindowId: number | null;
  tabs: ReadonlyMap<number, TrackedTab>;
};

export type PresenceTabSelection = {
  channel: TwitchChannel;
  tabId: number;
};

export type TabReport = {
  active: boolean;
  channel: TwitchChannel | null;
  now: number;
  tabId: number;
  windowId: number;
};

type StoredTab = {
  activatedAt: number;
  login: string | null;
  reportedAt: number;
  tabId: number;
  windowId: number;
};

export type StoredActiveTabState = {
  focusedWindowId: number | null;
  tabs: StoredTab[];
  version: 1;
};

export const ACTIVE_TAB_STATE_KEY = 'presence-active-tabs';

export const tabReportLease = 90_000;

const maximumTrackedTabs = 64;

export function createActiveTabState(): ActiveTabState {
  return {
    focusedWindowId: null,
    tabs: new Map(),
  };
}

function withTab(state: ActiveTabState, tabId: number, tab: TrackedTab | null): ActiveTabState {
  const tabs = new Map(state.tabs);

  if (tab) {
    tabs.set(tabId, tab);
  } else {
    tabs.delete(tabId);
  }

  return { ...state, tabs };
}

export function isForegroundReport(state: ActiveTabState, report: TabReport) {
  return (
    report.active && (state.focusedWindowId === null || report.windowId === state.focusedWindowId)
  );
}

function isMostRecentlyActivated(state: ActiveTabState, tabId: number, activatedAt: number) {
  for (const [otherTabId, tab] of state.tabs) {
    if (otherTabId !== tabId && tab.activatedAt >= activatedAt) {
      return false;
    }
  }

  return true;
}

function reportedActivationTime(state: ActiveTabState, report: TabReport) {
  const existing = state.tabs.get(report.tabId);

  if (!isForegroundReport(state, report)) {
    return existing?.activatedAt ?? 0;
  }

  if (existing && isMostRecentlyActivated(state, report.tabId, existing.activatedAt)) {
    return existing.activatedAt;
  }

  return report.now;
}

export function recordTabReport(state: ActiveTabState, report: TabReport): ActiveTabState {
  return withTab(state, report.tabId, {
    activatedAt: reportedActivationTime(state, report),
    channel: report.channel,
    reportedAt: report.now,
    windowId: report.windowId,
  });
}

export function recordTabActivation(
  state: ActiveTabState,
  tabId: number,
  windowId: number,
  now: number,
): ActiveTabState {
  const existing = state.tabs.get(tabId);

  if (!existing) {
    return state;
  }

  return withTab(state, tabId, { ...existing, activatedAt: now, windowId });
}

export function recordWindowFocus(
  state: ActiveTabState,
  windowId: number,
  activeTabId: number | null,
  now: number,
): ActiveTabState {
  if (windowId < 0) {
    return state;
  }

  const focused = { ...state, focusedWindowId: windowId };

  return activeTabId === null ? focused : recordTabActivation(focused, activeTabId, windowId, now);
}

export function removeTrackedTab(state: ActiveTabState, tabId: number): ActiveTabState {
  return state.tabs.has(tabId) ? withTab(state, tabId, null) : state;
}

export function pruneStaleTabs(state: ActiveTabState, now: number): ActiveTabState {
  let next = state;

  for (const [tabId, tab] of state.tabs) {
    if (now - tab.reportedAt > tabReportLease) {
      next = removeTrackedTab(next, tabId);
    }
  }

  if (next.tabs.size > maximumTrackedTabs) {
    const keep = [...next.tabs.entries()]
      .sort((left, right) => right[1].reportedAt - left[1].reportedAt)
      .slice(0, maximumTrackedTabs);

    next = { ...next, tabs: new Map(keep) };
  }

  return next;
}

export function selectPresenceTab(state: ActiveTabState): PresenceTabSelection | null {
  let selected: [number, TrackedTab & { channel: TwitchChannel }] | null = null;

  for (const [tabId, tab] of state.tabs) {
    if (!tab.channel) {
      continue;
    }

    if (
      !selected ||
      tab.activatedAt > selected[1].activatedAt ||
      (tab.activatedAt === selected[1].activatedAt &&
        (tab.reportedAt > selected[1].reportedAt ||
          (tab.reportedAt === selected[1].reportedAt && tabId > selected[0])))
    ) {
      selected = [tabId, { ...tab, channel: tab.channel }];
    }
  }

  return selected ? { channel: selected[1].channel, tabId: selected[0] } : null;
}

export function serializeActiveTabState(state: ActiveTabState): StoredActiveTabState {
  return {
    focusedWindowId: state.focusedWindowId,
    tabs: [...state.tabs.entries()].map(([tabId, tab]) => ({
      activatedAt: tab.activatedAt,
      login: tab.channel?.login ?? null,
      reportedAt: tab.reportedAt,
      tabId,
      windowId: tab.windowId,
    })),
    version: 1,
  };
}

function isSafeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function parseActiveTabState(value: unknown): ActiveTabState {
  const state = createActiveTabState();

  if (!value || typeof value !== 'object') {
    return state;
  }

  const stored = value as Record<string, unknown>;

  if (stored.version !== 1 || !Array.isArray(stored.tabs)) {
    return state;
  }

  const tabs = new Map<number, TrackedTab>();

  for (const item of stored.tabs.slice(0, maximumTrackedTabs)) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const tab = item as Record<string, unknown>;
    const channel =
      typeof tab.login === 'string'
        ? parseTwitchChannel(`https://www.twitch.tv/${tab.login}`)
        : null;

    if (
      !isSafeNumber(tab.tabId) ||
      tab.tabId < 0 ||
      !isSafeNumber(tab.windowId) ||
      !isSafeNumber(tab.activatedAt) ||
      !isSafeNumber(tab.reportedAt) ||
      (tab.login !== null && !channel)
    ) {
      continue;
    }

    tabs.set(tab.tabId, {
      activatedAt: tab.activatedAt,
      channel,
      reportedAt: tab.reportedAt,
      windowId: tab.windowId,
    });
  }

  return {
    focusedWindowId:
      isSafeNumber(stored.focusedWindowId) && stored.focusedWindowId >= 0
        ? stored.focusedWindowId
        : null,
    tabs,
  };
}
