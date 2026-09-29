import { create } from "zustand";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  /** Shows a toast that dismisses itself after `durationMs`; returns its id. */
  show: (message: string, options?: { action?: ToastAction; durationMs?: number }) => number;
  dismiss: (id: number) => void;
  /** Runs a toast's action once, then dismisses it. */
  runAction: (id: number) => void;
}

export const TOAST_DURATION_MS = 6000;
/** Older toasts give way once this many are on screen. */
const MAX_TOASTS = 3;

let nextId = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function clearTimer(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  show: (message, { action, durationMs = TOAST_DURATION_MS } = {}) => {
    nextId += 1;
    const id = nextId;
    const toasts = [...get().toasts, { id, message, action }];
    const dropped = toasts.slice(0, Math.max(0, toasts.length - MAX_TOASTS));
    dropped.forEach((t) => clearTimer(t.id));
    set({ toasts: toasts.slice(dropped.length) });
    timers.set(
      id,
      setTimeout(() => get().dismiss(id), durationMs),
    );
    return id;
  },

  dismiss: (id) => {
    clearTimer(id);
    if (get().toasts.some((t) => t.id === id)) set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  runAction: (id) => {
    const toast = get().toasts.find((t) => t.id === id);
    get().dismiss(id);
    toast?.action?.run();
  },
}));

export const showToast = (message: string, options?: { action?: ToastAction; durationMs?: number }) =>
  useToastStore.getState().show(message, options);
