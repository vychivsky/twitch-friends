import {
  createActiveTabState,
  parseActiveTabState,
  pruneStaleTabs,
  recordTabActivation,
  recordTabReport,
  recordWindowFocus,
  removeTrackedTab,
  selectPresenceTab,
  serializeActiveTabState,
  type ActiveTabState,
  type PresenceTabSelection,
  type StoredActiveTabState,
  type TabReport,
} from '@/features/presence/activeTabState';

export type PresenceTabTrackerDeps = {
  getActiveTabId(windowId: number): Promise<number | null>;
  getFocusedWindowId(): Promise<number | null>;
  loadState(): Promise<unknown>;
  now(): number;
  onError?(action: string, cause: unknown): void;
  onSelectionChange(selection: PresenceTabSelection | null): void;
  onUnchanged?(selection: PresenceTabSelection | null): void;
  saveState(state: StoredActiveTabState): Promise<void>;
  tabExists(tabId: number): Promise<boolean>;
};

const reportPersistGranularity = 15_000;

function persistenceKey(state: StoredActiveTabState) {
  return JSON.stringify({
    ...state,
    tabs: state.tabs.map((tab) => ({
      ...tab,
      reportedAt: Math.floor(tab.reportedAt / reportPersistGranularity),
    })),
  });
}

export class PresenceTabTracker {
  private lastPersisted: string | null = null;
  private queue: Promise<void>;
  private selectedLogin: string | null | undefined = undefined;
  private state: ActiveTabState = createActiveTabState();

  constructor(private readonly deps: PresenceTabTrackerDeps) {
    this.queue = this.restore();
  }

  reportChannel(report: Omit<TabReport, 'now'>) {
    return this.enqueue((state, now) => recordTabReport(state, { ...report, now }));
  }

  activateTab(tabId: number, windowId: number) {
    return this.enqueue((state, now) =>
      state.focusedWindowId !== null && state.focusedWindowId !== windowId
        ? state
        : recordTabActivation(state, tabId, windowId, now),
    );
  }

  focusWindow(windowId: number) {
    return this.enqueue(async (state, now) => {
      if (windowId < 0) {
        return state;
      }

      const activeTabId = await this.deps.getActiveTabId(windowId).catch(() => null);

      return recordWindowFocus(state, windowId, activeTabId, now);
    });
  }

  removeTab(tabId: number) {
    return this.enqueue((state) => removeTrackedTab(state, tabId));
  }

  heartbeat() {
    return this.enqueue((state) => state);
  }

  async getSelection() {
    await this.queue;

    return selectPresenceTab(this.state);
  }

  private enqueue(
    update: (state: ActiveTabState, now: number) => ActiveTabState | Promise<ActiveTabState>,
  ) {
    const next = this.queue.then(async () => {
      try {
        const now = this.deps.now();

        this.state = pruneStaleTabs(await update(this.state, now), now);
        await this.publish();
      } catch (cause) {
        this.deps.onError?.('Active tab state could not update', cause);
      }
    });

    this.queue = next;

    return next;
  }

  private async restore() {
    try {
      const restored = parseActiveTabState(await this.deps.loadState());
      const existence = await Promise.all(
        [...restored.tabs.keys()].map(async (tabId) => [
          tabId,
          await this.deps.tabExists(tabId).catch(() => false),
        ]),
      );
      let state = restored;

      for (const [tabId, exists] of existence) {
        if (!exists && typeof tabId === 'number') {
          state = removeTrackedTab(state, tabId);
        }
      }

      const focusedWindowId = await this.deps.getFocusedWindowId().catch(() => null);
      const activeTabId =
        focusedWindowId === null
          ? null
          : await this.deps.getActiveTabId(focusedWindowId).catch(() => null);
      const now = this.deps.now();

      this.state = pruneStaleTabs(
        focusedWindowId === null
          ? state
          : recordWindowFocus(state, focusedWindowId, activeTabId, now),
        now,
      );
      this.lastPersisted = persistenceKey(serializeActiveTabState(restored));
    } catch (cause) {
      this.state = createActiveTabState();
      this.deps.onError?.('Active tab state could not be restored', cause);
    }

    await this.publish();
  }

  private async publish() {
    const serialized = serializeActiveTabState(this.state);
    const key = persistenceKey(serialized);

    if (key !== this.lastPersisted) {
      this.lastPersisted = key;

      try {
        await this.deps.saveState(serialized);
      } catch (cause) {
        this.lastPersisted = null;
        this.deps.onError?.('Active tab state could not be saved', cause);
      }
    }

    const selection = selectPresenceTab(this.state);
    const login = selection?.channel.login ?? null;

    if (login !== this.selectedLogin) {
      this.selectedLogin = login;
      this.deps.onSelectionChange(selection);
    } else {
      this.deps.onUnchanged?.(selection);
    }
  }
}
