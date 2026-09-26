import { useEffect, useState } from "react";
import { Layout } from "./components/Layout";
import { useZoom } from "./lib/useZoom";
import { useMaximizedAttribute } from "./lib/useMaximizedAttribute";
import { setWorkspace } from "./lib/tauri-api";
import { confirmUnsaved } from "./lib/tabActions";
import { DialogHost } from "./components/DialogHost";
import { disposeAllModels } from "./lib/monacoModelRegistry";
import { pickFolder, rememberWorkspace, restoreLastWorkspace } from "./lib/workspace";
import { useEditorStore } from "./state/editorStore";
import { useTerminalStore } from "./state/terminalStore";
import "./App.css";

function App() {
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  useZoom();
  useMaximizedAttribute();

  useEffect(() => {
    let cancelled = false;
    restoreLastWorkspace()
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
    if (!selected || selected === workspaceRoot) return;

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
      useTerminalStore.getState().closeAll();
    }

    rememberWorkspace(selected);
    setWorkspaceRoot(selected);
  }

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
