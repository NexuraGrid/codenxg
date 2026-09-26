import { create } from "zustand";

interface PaletteState {
  isOpen: boolean;
  /** "" searches files; ":" starts in go-to-line mode (VS Code's Ctrl+G). */
  initialQuery: string;
  open: (initialQuery?: string) => void;
  close: () => void;
}

export const usePaletteStore = create<PaletteState>((set) => ({
  isOpen: false,
  initialQuery: "",
  open: (initialQuery = "") => set({ isOpen: true, initialQuery }),
  close: () => set({ isOpen: false }),
}));
