/**
 * Checkbox-style multi-selection over an ordered list of ids (a pin group's
 * files): click toggles one, Shift+click checks the range from the last
 * toggled item, and "select all" flips between everything and nothing.
 */
export interface ListSelection {
  checked: ReadonlySet<string>;
  /** The last item toggled on its own; where a Shift+click range starts. */
  anchor: string | null;
}

export const emptySelection: ListSelection = { checked: new Set(), anchor: null };

/** "toggle": Ctrl/Cmd+click, a checkbox click or Space. "range": Shift+click. */
export type SelectGesture = "toggle" | "range";

export function selectItem(items: readonly string[], selection: ListSelection, item: string, gesture: SelectGesture): ListSelection {
  const target = items.indexOf(item);
  if (target === -1) return selection;
  const from = selection.anchor === null ? -1 : items.indexOf(selection.anchor);

  if (gesture === "range" && from !== -1) {
    const checked = new Set(selection.checked);
    const [start, end] = from < target ? [from, target] : [target, from];
    for (const id of items.slice(start, end + 1)) checked.add(id);
    return { checked, anchor: selection.anchor };
  }

  const checked = new Set(selection.checked);
  if (checked.has(item)) checked.delete(item);
  else checked.add(item);
  return { checked, anchor: item };
}

/** Checks everything, or clears the selection when everything is already checked. */
export function toggleAll(items: readonly string[], selection: ListSelection): ListSelection {
  const all = items.length > 0 && items.every((id) => selection.checked.has(id));
  return all ? { checked: new Set(), anchor: selection.anchor } : { checked: new Set(items), anchor: selection.anchor };
}

export function selectAll(items: readonly string[], selection: ListSelection): ListSelection {
  return { checked: new Set(items), anchor: selection.anchor };
}

/** The checked items still in the list, in list order (removed ones drop out). */
export function checkedItems(items: readonly string[], selection: ListSelection): string[] {
  return items.filter((id) => selection.checked.has(id));
}
