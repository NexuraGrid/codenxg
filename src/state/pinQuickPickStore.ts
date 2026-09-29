import { create } from "zustand";
import { usePaletteStore } from "./paletteStore";

interface PinQuickPickState {
  isOpen: boolean;
  /** Opens straight at this group's files (step 2); null starts at the group list. */
  initialGroupId: string | null;
  /** Bumped on every open, so reopening while open (Ctrl+Alt+N) starts over. */
  session: number;
  open: (groupId?: string | null) => void;
  close: () => void;
}

export const usePinQuickPickStore = create<PinQuickPickState>((set) => ({
  isOpen: false,
  initialGroupId: null,
  session: 0,
  open: (groupId = null) => {
    // One modal at a time: it replaces Quick Open rather than stacking on it.
    usePaletteStore.getState().close();
    set((s) => ({ isOpen: true, initialGroupId: groupId, session: s.session + 1 }));
  },
  close: () => set({ isOpen: false }),
}));
