import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogStore } from "../state/dialogStore";

export function DialogHost() {
  const current = useDialogStore((s) => s.current);
  const close = useDialogStore((s) => s.close);
  const focusRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!current) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    focusRef.current?.focus();

    // Capture phase so Monaco/xterm don't also react to Escape/Enter.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(current!.request.cancelValue);
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      previousFocus?.focus?.();
    };
  }, [current, close]);

  if (!current) return null;
  const { request } = current;
  // Enter must never trigger an irreversible action by default: without a
  // primary button, focus lands on the cancel choice.
  const focusTarget =
    request.buttons.find((b) => b.variant === "primary") ??
    request.buttons.find((b) => b.value === request.cancelValue);

  return createPortal(
    <div className="dialog-backdrop" onPointerDown={() => close(request.cancelValue)}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2 id="dialog-title" className="dialog__title">
          {request.title}
        </h2>
        {request.message && <p className="dialog__message">{request.message}</p>}
        <div className="dialog__actions">
          {request.buttons.map((button) => (
            <button
              key={button.value}
              ref={button === focusTarget ? focusRef : undefined}
              className={`dialog__btn${button.variant ? ` is-${button.variant}` : ""}`}
              onClick={() => close(button.value)}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
