import { create } from "zustand";
import { readSettings, writeSettings } from "../lib/tauri-api";
import { DEFAULT_SETTINGS, mergeSettings, type AppSettings, type EditorSettings, type FilesSettings, type TerminalSettings } from "../lib/settingsSchema";

const PERSIST_DEBOUNCE_MS = 300;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

// Fire-and-forget on purpose: a failed write just means the change won't
// survive a restart, which isn't worth blocking the UI over.
function persist(settings: AppSettings): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    writeSettings(JSON.stringify(settings)).catch(console.error);
  }, PERSIST_DEBOUNCE_MS);
}

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  /** Reads the settings file once at startup; safe to call more than once. */
  load: () => Promise<void>;
  updateEditor: (patch: Partial<EditorSettings>) => void;
  updateFiles: (patch: Partial<FilesSettings>) => void;
  updateTerminal: (patch: Partial<TerminalSettings>) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const raw = await readSettings();
      const parsed = raw ? JSON.parse(raw) : undefined;
      set({ settings: mergeSettings(parsed), loaded: true });
    } catch {
      // A corrupt or unreadable file: fall back to defaults rather than crash.
      set({ settings: DEFAULT_SETTINGS, loaded: true });
    }
  },

  updateEditor: (patch) =>
    set((state) => {
      const settings = { ...state.settings, editor: { ...state.settings.editor, ...patch } };
      persist(settings);
      return { settings };
    }),

  updateFiles: (patch) =>
    set((state) => {
      const settings = { ...state.settings, files: { ...state.settings.files, ...patch } };
      persist(settings);
      return { settings };
    }),

  updateTerminal: (patch) =>
    set((state) => {
      const settings = { ...state.settings, terminal: { ...state.settings.terminal, ...patch } };
      persist(settings);
      return { settings };
    }),
}));
