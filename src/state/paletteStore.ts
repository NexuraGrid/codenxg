import { create } from "zustand";

interface PaletteState {
  isOpen: boolean;
  /** The Command Palette (Ctrl+Shift+P) rather than Quick Open's file search. */
  commandMode: boolean;
  /** "" searches files; ":" starts in go-to-line mode (VS Code's Ctrl+G). In command mode, the filter text. */
  initialQuery: string;
  open: (initialQuery?: string) => void;
  openCommands: (initialQuery?: string) => void;
  close: () => void;
}

export const usePaletteStore = create<PaletteState>((set) => ({
  isOpen: false,
  commandMode: false,
  initialQuery: "",
  open: (initialQuery = "") => set({ isOpen: true, commandMode: false, initialQuery }),
  openCommands: (initialQuery = "") => set({ isOpen: true, commandMode: true, initialQuery }),
  close: () => set({ isOpen: false }),
}));
