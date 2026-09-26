import type { EditorTab } from "../state/editorStore";
import type { AutoSaveMode } from "./settingsSchema";

/** A tab worth auto-saving: a real, dirty file — never a synthetic view. */
export function isRealFileTab(tab: EditorTab): boolean {
  return !tab.commit && !tab.stash && !tab.settings;
}

export function autoSavableTabs(tabs: EditorTab[]): EditorTab[] {
  return tabs.filter((tab) => tab.isDirty && isRealFileTab(tab));
}

export type AutoSaveTrigger = "delay" | "blur" | "tab-switch";

/** Whether `trigger` is the kind of event `mode` reacts to. */
export function autoSaveAppliesTo(mode: AutoSaveMode, trigger: AutoSaveTrigger): boolean {
  switch (mode) {
    case "off":
      return false;
    case "afterDelay":
      return trigger === "delay";
    case "onFocusChange":
      return trigger === "blur" || trigger === "tab-switch";
  }
}
