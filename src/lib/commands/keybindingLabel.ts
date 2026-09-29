import { isMacPlatform } from "../pinGroupQuickPick";

const MAC_SYMBOLS: Record<string, string> = { mod: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥" };
const NAMES: Record<string, string> = { mod: "Ctrl", ctrl: "Ctrl", shift: "Shift", alt: "Alt" };
const KEY_NAMES: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  space: "Space",
  tab: "Tab",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageup: "PageUp",
  pagedown: "PageDown",
};

function formatStroke(stroke: string, mac: boolean): string {
  const parts = stroke.toLowerCase().split("+");
  const rawKey = parts.pop() ?? "";
  const key = KEY_NAMES[rawKey] ?? rawKey.toUpperCase();
  if (mac) return parts.map((m) => MAC_SYMBOLS[m] ?? m).join("") + key;
  return [...parts.map((m) => NAMES[m] ?? m), key].join("+");
}

/**
 * How a useHotkey-style combo reads on this platform: "mod+shift+p" is
 * "Ctrl+Shift+P" ("⌘⇧P" on macOS, like quickPickShortcutLabel); a space separates the
 * strokes of a chord ("mod+k v" → "Ctrl+K V").
 */
export function formatKeybinding(combo: string, mac = isMacPlatform()): string {
  return combo
    .trim()
    .split(/\s+/)
    .map((stroke) => formatStroke(stroke, mac))
    .join(" ");
}
