import { create } from "zustand";

export interface DialogButton<T extends string> {
  label: string;
  value: T;
  /** "danger" marks an irreversible action; it never receives initial focus. */
  variant?: "primary" | "danger" | "default";
}

export interface DialogRequest<T extends string> {
  title: string;
  message?: string;
  buttons: DialogButton<T>[];
  /** Returned on Escape or a click on the backdrop. */
  cancelValue: T;
  /** Shows an indeterminate progress bar: something is still running. */
  busy?: boolean;
}

interface OpenDialog {
  request: DialogRequest<string>;
  resolve: (value: string) => void;
}

interface DialogState {
  current: OpenDialog | null;
  close: (value: string) => void;
}

export const useDialogStore = create<DialogState>((set, get) => ({
  current: null,
  close: (value) => {
    const current = get().current;
    if (!current) return;
    set({ current: null });
    current.resolve(value);
  },
}));

// In-app replacement for the native GTK dialog, which opened outside the
// window with the system's look.
export function showDialog<T extends string>(request: DialogRequest<T>): Promise<T> {
  // A dialog already on screen is answered with its cancel value first.
  const previous = useDialogStore.getState().current;
  if (previous) useDialogStore.getState().close(previous.request.cancelValue);

  return new Promise<T>((resolve) => {
    useDialogStore.setState({
      current: {
        request: request as DialogRequest<string>,
        resolve: (value) => resolve(value as T),
      },
    });
  });
}
