import { create } from "zustand";
import { closeTerminal } from "../lib/tauri-api";

// xterm.js Terminal instances (with their scrollback buffer) are NOT stored
// here — same reasoning as Monaco models. This store only tracks metadata.
export interface TerminalSessionMeta {
  id: string;
  title: string;
}

interface TerminalState {
  sessions: TerminalSessionMeta[];
  activeSessionId: string | null;
  /** Numbers titles like VS Code ("Terminal 1", "Terminal 2", ...). */
  nextNumber: number;
  createSession: () => void;
  /** Idempotent: StrictMode runs mount effects twice. */
  ensureSession: () => void;
  /** Kills the shell and drops the tab. */
  closeSession: (id: string) => void;
  /** Drops the tab of a shell that already exited on its own. */
  forgetSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  /** Kills every shell; used when switching projects. */
  closeAll: () => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  nextNumber: 1,

  createSession: () =>
    set((state) => {
      const session = { id: crypto.randomUUID(), title: `Terminal ${state.nextNumber}` };
      return {
        sessions: [...state.sessions, session],
        activeSessionId: session.id,
        nextNumber: state.nextNumber + 1,
      };
    }),

  ensureSession: () => {
    if (get().sessions.length === 0) get().createSession();
  },

  closeSession: (id) => {
    closeTerminal(id).catch(console.error);
    get().forgetSession(id);
  },

  forgetSession: (id) =>
    set((state) => {
      const index = state.sessions.findIndex((s) => s.id === id);
      if (index === -1) return state;
      const sessions = state.sessions.filter((s) => s.id !== id);
      // Like VS Code: focus the neighbour of the closed tab.
      const activeSessionId =
        state.activeSessionId === id
          ? (sessions[Math.min(index, sessions.length - 1)]?.id ?? null)
          : state.activeSessionId;
      return { sessions, activeSessionId };
    }),

  setActiveSession: (id) => set({ activeSessionId: id }),

  closeAll: () => {
    for (const { id } of get().sessions) closeTerminal(id).catch(console.error);
    set({ sessions: [], activeSessionId: null, nextNumber: 1 });
  },
}));
