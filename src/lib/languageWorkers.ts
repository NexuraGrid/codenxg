import * as monaco from "monaco-editor";

// Monaco stops its CSS/HTML/JSON workers after two idle minutes, but never the
// TypeScript ones (setMaximumWorkerIdleTime is a no-op): each holds the whole
// compiler, 100+ MB, for the rest of the session. Changing a language's
// defaults makes Monaco drop its worker; the next JS/TS file starts a new one.
const WORKER_LANGUAGES = [
  { id: "typescript", defaults: monaco.typescript.typescriptDefaults },
  { id: "javascript", defaults: monaco.typescript.javascriptDefaults },
];

/** Stops the TS/JS worker of each language with no open model left. */
export function releaseIdleLanguageWorkers(): void {
  const openLanguages = new Set(monaco.editor.getModels().map((m) => m.getLanguageId()));
  for (const { id, defaults } of WORKER_LANGUAGES) {
    if (!openLanguages.has(id)) defaults.setCompilerOptions(defaults.getCompilerOptions());
  }
}
