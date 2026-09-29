import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { flyoutStyle, useFlyoutPlacement } from "./useFlyoutPlacement";

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
  | {
      type: "submenu";
      label: string;
      disabled?: boolean;
      checked?: boolean;
      detail?: string;
      /** Clicking the item runs this (and closes the menu) instead of just opening the submenu. */
      onSelect?: () => void;
      entries: ContextMenuEntry[];
    }
  | { type: "separator" };

interface ContextMenuProps {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
  onClose: () => void;
}

const VIEWPORT_MARGIN = 8;

const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"]);

/** The enabled items of one menu level (not those of its submenus). */
function menuItems(menu: Element): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>(
      ":scope > .context-menu__item, :scope > .context-menu__submenu-anchor > .context-menu__item",
    ),
  ).filter((item) => !(item as HTMLButtonElement).disabled);
}

/**
 * Arrow-key navigation: Up/Down (Home/End) move within a level, Right enters
 * a submenu, Left returns to its item. Enter/Space are the buttons' own.
 */
function navigateMenu(root: HTMLElement, event: KeyboardEvent): boolean {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const inside = focused !== null && root.contains(focused);
  if (!inside) {
    // Focus is still on whatever opened the menu: Down/Up step into it.
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
    const items = menuItems(root);
    (event.key === "ArrowDown" ? items[0] : items[items.length - 1])?.focus();
    return true;
  }
  const menu = focused.closest(".context-menu") ?? root;
  const items = menuItems(menu);
  const index = items.indexOf(focused);
  switch (event.key) {
    case "ArrowDown":
      items[(index + 1) % items.length]?.focus();
      return true;
    case "ArrowUp":
      items[(index - 1 + items.length) % items.length]?.focus();
      return true;
    case "Home":
      items[0]?.focus();
      return true;
    case "End":
      items[items.length - 1]?.focus();
      return true;
    case "ArrowRight": {
      const submenu = focused.parentElement?.querySelector(":scope > .context-menu__submenu");
      if (!submenu) return false;
      menuItems(submenu)[0]?.focus();
      return true;
    }
    case "ArrowLeft": {
      if (menu === root) return false;
      menu.parentElement?.querySelector<HTMLElement>(":scope > .context-menu__item")?.focus();
      return true;
    }
  }
  return false;
}

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
    // Captured so arrows reach the menu ahead of whatever still has focus.
    function onNavKey(event: KeyboardEvent) {
      const root = menuRef.current;
      if (!root || !NAV_KEYS.has(event.key)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && !root.contains(target) && target.closest("input, textarea, .monaco-editor, .xterm")) return;
      if (navigateMenu(root, event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    // Wheel inside a (scrollable) menu scrolls it; anywhere else closes it.
    function onWheel(event: WheelEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }

    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onNavKey, { capture: true });
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onNavKey, { capture: true });
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", onWheel);
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
            onFocus={() => setOpenSubmenu(null)}
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

/**
 * A nested menu beside its item, opened on hover, focus or click; flips left
 * near the window's right edge and scrolls when taller than the window.
 */
function Submenu({ entry, open, onOpen, onClose }: SubmenuProps) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const placement = useFlyoutPlacement(anchorRef, panelRef, open, entry.entries.length);

  return (
    <div ref={anchorRef} className="context-menu__submenu-anchor" onPointerEnter={() => !entry.disabled && onOpen()}>
      <button
        className="context-menu__item"
        role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={entry.checked}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={entry.disabled}
        onFocus={onOpen}
        onClick={() => {
          if (!entry.onSelect) {
            onOpen();
            return;
          }
          onClose();
          entry.onSelect();
        }}
      >
        <span className="context-menu__label">
          {entry.checked !== undefined && <span className="context-menu__check">{entry.checked ? "✓" : ""}</span>}
          {entry.label}
          {entry.detail && <span className="context-menu__detail">{entry.detail}</span>}
        </span>
        <span className="context-menu__arrow">›</span>
      </button>
      {open && (
        <div ref={panelRef} className="context-menu context-menu__submenu" role="menu" style={flyoutStyle(placement)}>
          <MenuEntries entries={entry.entries} onClose={onClose} />
        </div>
      )}
    </div>
  );
}
