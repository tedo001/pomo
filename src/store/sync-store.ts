import { create } from "zustand";
import { pendingChangeCount, syncEngine, type SyncReport } from "../lib/sync/sync-engine";
import { useSettings } from "./settings-store";

interface SyncStore {
  status: "idle" | "syncing" | "ok" | "error";
  pending: number;
  lastReport: SyncReport | null;
  refreshPending(): Promise<void>;
  syncNow(): Promise<void>;
  startAutoSync(): () => void;
}

const AUTO_SYNC_INTERVAL_MS = 60_000;

export const useSync = create<SyncStore>((set, get) => ({
  status: "idle",
  pending: 0,
  lastReport: null,

  async refreshPending() {
    set({ pending: await pendingChangeCount() });
  },

  async syncNow() {
    if (useSettings.getState().settings.syncMode === "local") {
      await get().refreshPending();
      return;
    }
    set({ status: "syncing" });
    const report = await syncEngine.sync();
    set({ status: report.ok ? "ok" : "error", lastReport: report });
    await get().refreshPending();
  },

  /**
   * Periodic sync plus two event-driven triggers: coming back online, and the tab
   * regaining focus. Polling alone would leave a laptop that just woke up showing stale
   * data for up to a minute, which is exactly when the user looks at it.
   */
  startAutoSync() {
    const tick = () => {
      if (document.visibilityState === "visible") void get().syncNow();
    };
    const interval = window.setInterval(tick, AUTO_SYNC_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void get().syncNow();
    };
    window.addEventListener("online", tick);
    document.addEventListener("visibilitychange", onVisible);
    void get().refreshPending();

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  },
}));
