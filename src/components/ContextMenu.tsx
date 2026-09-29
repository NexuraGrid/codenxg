import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type ContextMenuEntry =
  | {
      type: "item";
      label: string;
      shortcut?: string;
      disabled?: boolean;
      checked?: boolean;
      /** Shown before the label, e.g. a file icon. */
      icon?: ReactNode;
      /** Dimmed text after the label, e.g. a file's folder. */
      detail?: string;
      /** Nests the item one level under the one above it. */
      indent?: boolean;
      onSelect: () => void;
    }
  | { type: "submenu"; label: string; disabled?: boolean; entries: ContextMenuEntry[] }
  | { type: "separator" };

interface ContextMenuProps {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
  onClose: () => void;
}

const VIEWPORT_MARGIN = 8;

export function ContextMenu({ x, y, entries, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Flip/clamp so a menu opened near the right or bottom edge stays visible.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    setPosition({
      left: Math.max(VIEWPORT_MARGIN, Math.min(x, maxLeft)),
      top: Math.max(VIEWPORT_MARGIN, y > maxTop ? y - height : y),
    });
  }, [x, y]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      style={position}
      // React events bubble through portals to the component that opened the
      // menu; stop them so a right-click here doesn't reopen it.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <MenuEntries entries={entries} onClose={onClose} />
    </div>,
    document.body,
  );
}

function MenuEntries({ entries, onClose }: { entries: ContextMenuEntry[]; onClose: () => void }) {
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);
  return (
    <>
      {entries.map((entry, i) => {
        if (entry.type === "separator") return <div key={i} className="context-menu__separator" role="separator" />;
        if (entry.type === "submenu") {
          return (
            <Submenu
              key={i}
              entry={entry}
              open={openSubmenu === i}
              onOpen={() => setOpenSubmenu(i)}
              onClose={onClose}
            />
          );
        }
        return (
          <button
            key={i}
            className={`context-menu__item${entry.indent ? " is-indented" : ""}`}
            role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={entry.checked}
            disabled={entry.disabled}
            onPointerEnter={() => setOpenSubmenu(null)}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            <span className="context-menu__label">
              {entry.checked !== undefined && <span className="context-menu__check">{entry.checked ? "✓" : ""}</span>}
              {entry.icon}
              {entry.label}
              {entry.detail && <span className="context-menu__detail">{entry.detail}</span>}
            </span>
            {entry.shortcut && <kbd className="context-menu__shortcut">{entry.shortcut}</kbd>}
          </button>
        );
      })}
    </>
  );
}

interface SubmenuProps {
  entry: Extract<ContextMenuEntry, { type: "submenu" }>;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

/** A nested menu beside its item, opened on hover or click; flips left near the window's right edge. */
function Submenu({ entry, open, onOpen, onClose }: SubmenuProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [flip, setFlip] = useState(false);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const { right } = panel.getBoundingClientRect();
    setFlip(right > window.innerWidth - VIEWPORT_MARGIN);
  }, [open]);

  return (
    <div className="context-menu__submenu-anchor" onPointerEnter={() => !entry.disabled && onOpen()}>
      <button
        className="context-menu__item"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={entry.disabled}
        onClick={onOpen}
      >
        <span>{entry.label}</span>
        <span className="context-menu__arrow">›</span>
      </button>
      {open && (
        <div ref={panelRef} className={`context-menu context-menu__submenu${flip ? " is-flipped" : ""}`} role="menu">
          <MenuEntries entries={entry.entries} onClose={onClose} />
        </div>
      )}
    </div>
  );
}
