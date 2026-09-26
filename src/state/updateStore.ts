import { create } from "zustand";

export type UpdatePhase = "idle" | "checking" | "downloading" | "installing";

interface UpdateState {
  phase: UpdatePhase;
  /** 0–1 while downloading; null when the total size is unknown. */
  progress: number | null;
  setPhase: (phase: UpdatePhase) => void;
  setProgress: (progress: number | null) => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  phase: "idle",
  progress: null,
  setPhase: (phase) => set({ phase, progress: null }),
  setProgress: (progress) => set({ progress }),
}));
