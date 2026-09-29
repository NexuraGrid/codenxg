// Find References (Shift+F12) needs a Monaco model for every referenced
// file so the peek widget can show a preview: Monaco's default
// ITextModelService.createModelReference just reads whatever model already
// exists (see StandaloneTextModelService in monaco-editor) — it never loads
// one. Files the user has open already have one; for the rest we load one
// ourselves through the same registry a real tab would use, so if the file
// is later actually opened, MonacoEditor's `getModel(path) ?? createModel`
// finds this one instead of colliding with it.
//
// To avoid leaking these "loaned" models forever, each new batch releases
// whatever the previous batch loaned and never got promoted to a real tab.
import * as monaco from "monaco-editor";
import { allTabs, useEditorStore } from "../../state/editorStore";
import { createModel, disposeModel, getModel } from "../monacoModelRegistry";
import { pathFromUri } from "../paths";
import { readFile } from "../tauri-api";
import { languageFromPath } from "../language";

let loanedPaths = new Set<string>();

/** Loads a model for every location's file that doesn't have one yet. */
export async function ensureModelsForLocations(locations: monaco.languages.Location[]): Promise<void> {
  releaseUnusedLoanedModels();

  const paths = new Set(locations.map((l) => pathFromUri(l.uri)));
  await Promise.all(
    [...paths].map(async (path) => {
      if (getModel(path)) return;
      let content: string;
      try {
        content = await readFile(path);
      } catch {
        return; // Deleted or unreadable: the peek preview is just empty for it.
      }
      if (getModel(path)) return; // Lost the race with another concurrent load.
      createModel(path, content, languageFromPath(path));
      loanedPaths.add(path);
    }),
  );
}

/** Disposes every loaned model that never became a real tab in the meantime. */
export function releaseUnusedLoanedModels(): void {
  if (loanedPaths.size === 0) return;
  const openPaths = new Set(allTabs(useEditorStore.getState()).map((t) => t.path));
  for (const path of loanedPaths) {
    if (!openPaths.has(path)) disposeModel(path);
  }
  loanedPaths = new Set([...loanedPaths].filter((path) => openPaths.has(path)));
}
