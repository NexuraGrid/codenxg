import { describe, expect, it } from "vitest";
import * as monaco from "monaco-editor";
import { registerSemanticHighlighting } from "../semanticHighlight";

// Monaco's own basic languages (php, python, java...) register a tokenizer
// factory for their real language id as soon as "monaco-editor" is imported.
// registerTokensProviderFactory is exclusive with itself: whichever call
// happens last wins the id. This locks in that our factory is the one Monaco
// actually calls for a *real* id, not just a disposable test id like the
// other cases in semanticHighlight.test.ts use to sidestep this entirely.
async function waitForEnhancedToken(languageId: string, code: string, target: string, timeoutMs = 2000): Promise<string> {
  const model = monaco.editor.createModel(code, languageId);
  const lines = code.split("\n");
  const lineIndex = lines.findIndex((l) => l.includes(target));
  const offset = lines[lineIndex].indexOf(target);
  const deadline = Date.now() + timeoutMs;
  try {
    let type = "";
    while (Date.now() < deadline) {
      const tokenLines = monaco.editor.tokenize(code, languageId);
      type = tokenLines[lineIndex]?.find((t) => t.offset === offset)?.type ?? "";
      if (type && !type.startsWith("identifier")) return type;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return type;
  } finally {
    model.dispose();
  }
}

describe("registerSemanticHighlighting against Monaco's own real language ids", () => {
  it("colors a PHP call as a function instead of Monaco's own plain identifier", async () => {
    registerSemanticHighlighting(monaco);
    const type = await waitForEnhancedToken("php", "<?php\nfunction foo($x) { return $x; }\n?>", "foo");
    expect(type).toBe("function");
  });
});
