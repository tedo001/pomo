import { create } from "zustand";
import { loadSettings, saveSettings } from "../lib/db";
import { DEFAULT_SETTINGS, type Settings } from "../lib/types";

interface SettingsStore {
  settings: Settings;
  loaded: boolean;
  hydrate(): Promise<void>;
  update(patch: Partial<Omit<Settings, "id">>): Promise<void>;
}

/**
 * Settings are read on nearly every render (day boundaries, durations, theme), so they
 * live in memory and are written through to IndexedDB. `loaded` exists so the shell can
 * hold the first paint rather than flashing defaults and then correcting itself.
 */
export const useSettings = create<SettingsStore>((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  async hydrate() {
    const settings = await loadSettings();
    set({ settings, loaded: true });
  },

  async update(patch) {
    const settings = await saveSettings(patch);
    set({ settings });
  },
}));
