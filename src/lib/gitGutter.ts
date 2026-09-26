import type * as monacoTypes from "monaco-editor";
import { diffLines } from "./lineDiff";
import { pathOfModel } from "./monacoModelRegistry";
import { headText, useGitStore } from "../state/gitStore";

type Editor = monacoTypes.editor.ICodeEditor;

// Recomputing on every keystroke is wasted work; a pause is enough.
const TYPING_PAUSE_MS = 250;

/**
 * VS Code's gutter bars: added / modified lines and deletion markers against
 * the committed version. Files git doesn't track (or outside a repo) get none.
 */
export function attachGitGutter(editor: Editor): () => void {
  const decorations = editor.createDecorationsCollection();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let run = 0;

  async function update() {
    const current = ++run;
    const model = editor.getModel();
    const path = model && pathOfModel(model);
    if (!model || !path || !useGitStore.getState().status?.isRepo) {
      decorations.clear();
      return;
    }
    const head = await headText(path);
    // A newer update (tab switch, typing) started while git was answering.
    if (current !== run || model.isDisposed()) return;
    if (head === null) {
      decorations.clear();
      return;
    }

    const changes = diffLines(head.split(/\r?\n/), model.getLinesContent());
    decorations.set(
      changes.map(({ kind, start, end }) => ({
        range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 },
        options: { isWholeLine: true, linesDecorationsClassName: `git-gutter git-gutter--${kind}` },
      })),
    );
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => void update(), TYPING_PAUSE_MS);
  }

  const onModel = editor.onDidChangeModel(() => void update());
  const onContent = editor.onDidChangeModelContent(schedule);
  // A commit (HEAD moved) or the first status of the session.
  const unsubscribe = useGitStore.subscribe((state, previous) => {
    if (state.headVersion !== previous.headVersion || state.status?.isRepo !== previous.status?.isRepo) {
      void update();
    }
  });
  void update();

  return () => {
    clearTimeout(timer);
    run++;
    onModel.dispose();
    onContent.dispose();
    unsubscribe();
    decorations.clear();
  };
}
