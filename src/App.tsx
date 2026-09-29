import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Layout } from "./components/Layout";
import { useZoom } from "./lib/useZoom";
import { useMaximizedAttribute } from "./lib/useMaximizedAttribute";
import { useApplyEditorSettings } from "./lib/useApplyEditorSettings";
import { launchFolder, setWorkspace } from "./lib/tauri-api";
import { confirmUnsaved } from "./lib/tabActions";
import { DialogHost } from "./components/DialogHost";
import { disposeAllModels } from "./lib/monacoModelRegistry";
import { pickFolder, rememberWorkspace, restoreLastWorkspace } from "./lib/workspace";
import { useEditorStore } from "./state/editorStore";
import { usePinGroupStore } from "./state/pinGroupStore";
import { useSettingsStore } from "./state/settingsStore";
import { useTerminalStore } from "./state/terminalStore";
import { checkForUpdates } from "./lib/updater";
import "./App.css";

// A folder given on the command line wins over the last remembered project.
async function startupWorkspace(): Promise<string | null> {
  try {
    const folder = await launchFolder();
    if (folder) {
      await setWorkspace(folder);
      rememberWorkspace(folder);
      return folder;
    }
  } catch (error) {
    console.error(error);
  }
  return restoreLastWorkspace();
}

function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  useZoom();
  useMaximizedAttribute();
  useApplyEditorSettings();

  useEffect(() => {
    void useSettingsStore.getState().load();
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    void checkForUpdates({ silent: true });
  }, []);

  useEffect(() => {
    let cancelled = false;
    startupWorkspace()
      .then((path) => {
        if (!cancelled && path) setWorkspaceRoot(path);
      })
      .finally(() => {
        if (!cancelled) setIsRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleOpenFolder() {
    const selected = await pickFolder();
    if (selected) await openWorkspace(selected);
  }

  async function openWorkspace(selected: string) {
    if (selected === workspaceRoot) return;

    if (workspaceRoot) {
      const { tabs } = useEditorStore.getState();
      if (!(await confirmUnsaved(tabs))) return;
    }

    // Switch the backend's scope first: if it refuses, the current project
    // stays fully open instead of half torn down.
    try {
      await setWorkspace(selected);
    } catch (error) {
      console.error(error);
      return;
    }

    if (workspaceRoot) {
      disposeAllModels();
      useEditorStore.getState().reset();
      usePinGroupStore.getState().reset();
      useTerminalStore.getState().closeAll();
    }

    rememberWorkspace(selected);
    setWorkspaceRoot(selected);
  }

  // The listener outlives renders, so it calls the latest closure.
  const openWorkspaceRef = useRef(openWorkspace);
  openWorkspaceRef.current = openWorkspace;

  useEffect(() => {
    const unlisten = listen<string>("open-folder", (event) => {
      void openWorkspaceRef.current(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  function renderScreen() {
    // Avoids flashing the welcome screen while the last project is reopened.
    if (isRestoring) return <main className="app" />;

    if (!workspaceRoot) {
      return (
        <main className="welcome-screen" data-tauri-drag-region>
          <h1>Code Editor</h1>
          <button onClick={handleOpenFolder}>Open Folder</button>
        </main>
      );
    }

    // Keyed by project so tree, panels and terminal start clean on a switch.
    return <Layout key={workspaceRoot} workspaceRoot={workspaceRoot} onOpenFolder={handleOpenFolder} />;
  }

  return (
    <>
      {renderScreen()}
      <DialogHost />
    </>
  );
}

export default App;
