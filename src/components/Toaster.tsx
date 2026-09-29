import { useToastStore } from "../state/toastStore";
import { CloseIcon } from "./icons";

/** Transient notices, bottom-right; each dismisses itself (see toastStore). */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  const { dismiss, runAction } = useToastStore.getState();
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <span className="toast__message">{toast.message}</span>
          {toast.action && (
            <button className="toast__action" onClick={() => runAction(toast.id)}>
              {toast.action.label}
            </button>
          )}
          <button className="icon-btn toast__close" title="Dismiss" onClick={() => dismiss(toast.id)}>
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
