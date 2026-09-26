import * as monaco from "monaco-editor";

// Formats Monaco has no tokenizer for, mapped to the closest built-in one.
// Vue/Svelte/Astro single-file components are HTML at the top level, and
// Monaco's HTML tokenizer already delegates <script>/<style> to JS/CSS.
const FALLBACK_BY_EXTENSION: Record<string, string> = {
  vue: "html",
  svelte: "html",
  astro: "html",
  toml: "ini",
  env: "ini",
  conf: "ini",
  jsonc: "json",
};

let byExtension: Map<string, string> | null = null;
let byFileName: Map<string, string> | null = null;

// Built once from Monaco's own registry (~80 languages with their extensions
// and special file names) instead of a hand-maintained list that goes stale.
function buildIndex() {
  byExtension = new Map();
  byFileName = new Map();
  for (const language of monaco.languages.getLanguages()) {
    for (const ext of language.extensions ?? []) {
      const key = ext.toLowerCase().replace(/^\./, "");
      if (!byExtension.has(key)) byExtension.set(key, language.id);
    }
    for (const fileName of language.filenames ?? []) {
      const key = fileName.toLowerCase();
      if (!byFileName.has(key)) byFileName.set(key, language.id);
    }
  }
}

export function languageFromPath(path: string): string {
  if (!byExtension || !byFileName) buildIndex();

  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const exact = byFileName!.get(name);
  if (exact) return exact;

  // Longest extension first, so "app.blade.php" can match a compound
  // extension before falling back to "php".
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const language = byExtension!.get(ext) ?? FALLBACK_BY_EXTENSION[ext];
    if (language) return language;
  }

  return "plaintext";
}
