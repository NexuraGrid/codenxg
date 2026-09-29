import { useEffect, useRef } from "react";
import { allTabs, uniqueOpenTabs, useEditorStore } from "../state/editorStore";
import { useSettingsStore } from "../state/settingsStore";
import { onModelChange } from "./monacoModelRegistry";
import { saveFile } from "./fileSave";
import { autoSaveAppliesTo, autoSavableTabs, isRealFileTab } from "./autoSave";

/**
 * Wires the "Auto save" setting to the existing save path (fileSave.ts), so
 * atomic writes, watcher suppression and LSP didSave all keep working the
 * same as a manual Ctrl+S. Never touches untitled/virtual tabs (see autoSave.ts).
 */
export function useAutoSave(): void {
  const mode = useSettingsStore((s) => s.settings.files.autoSave);
  const delayMs = useSettingsStore((s) => s.settings.files.autoSaveDelayMs);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = timersRef.current;

    function saveIfDirty(path: string | null) {
      if (!path) return;
      const tab = allTabs(useEditorStore.getState()).find((t) => t.path === path);
      if (tab && tab.isDirty && isRealFileTab(tab)) saveFile(path).catch(console.error);
    }

    const disposers: (() => void)[] = [];

    if (autoSaveAppliesTo(mode, "delay")) {
      disposers.push(
        onModelChange((path) => {
          clearTimeout(timers.get(path));
          timers.set(
            path,
            setTimeout(() => {
              timers.delete(path);
              saveIfDirty(path);
            }, delayMs),
          );
        }),
      );
    }

    if (autoSaveAppliesTo(mode, "blur")) {
      const onBlur = () => {
        for (const tab of autoSavableTabs(uniqueOpenTabs(useEditorStore.getState()))) saveIfDirty(tab.path);
      };
      window.addEventListener("blur", onBlur);
      disposers.push(() => window.removeEventListener("blur", onBlur));
    }

    if (autoSaveAppliesTo(mode, "tab-switch")) {
      let previousPath = useEditorStore.getState().activeTabPath;
      disposers.push(
        useEditorStore.subscribe((state) => {
          if (state.activeTabPath !== previousPath) {
            saveIfDirty(previousPath);
            previousPath = state.activeTabPath;
          }
        }),
      );
    }

    return () => {
      for (const dispose of disposers) dispose();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [mode, delayMs]);
}
