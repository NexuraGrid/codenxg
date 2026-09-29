import { describe, expect, it } from "vitest";
import lspSource from "../../../src-tauri/src/commands/lsp.rs?raw";
import { SERVED_LANGUAGES } from "../lsp/servedLanguages";
import { languageFromPath, registerVueLanguage } from "../language";

// The webview only starts sessions for SERVED_LANGUAGES and the backend only
// runs servers it has in SERVERS: the two lists must agree.
function rustServerLanguages(): string[] {
  const start = lspSource.indexOf("const SERVERS");
  const table = lspSource.slice(start, lspSource.indexOf("\n];", start));
  // Top-level entries only (4-space indent), not the candidates inside them.
  return [...table.matchAll(/^ {4}\(\s*"([a-z]+)"/gm)].map((m) => m[1]);
}

describe("served languages", () => {
  it("match the backend's SERVERS table", () => {
    expect([...SERVED_LANGUAGES].sort()).toEqual(rustServerLanguages().sort());
  });

  it("are all ids Monaco knows, so files actually get them", () => {
    registerVueLanguage();
    const paths: Record<string, string> = {
      php: "a.php", python: "a.py", java: "A.java", go: "a.go", rust: "a.rs", c: "a.c",
      cpp: "a.cpp", yaml: "a.yaml", shell: "a.sh", vue: "App.vue",
    };
    for (const language of SERVED_LANGUAGES) expect(languageFromPath(`/ws/${paths[language]}`)).toBe(language);
  });
});
