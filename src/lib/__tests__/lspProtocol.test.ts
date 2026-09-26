import { describe, expect, it } from "vitest";
import * as monaco from "monaco-editor";
import { toCompletionItem, toLocations, toMarkdown, toMarker, toMonacoRange } from "../lsp/protocol";

const RANGE = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 };

describe("LSP to Monaco conversions", () => {
  it("shifts positions from 0-based to 1-based", () => {
    expect(toMonacoRange({ start: { line: 0, character: 2 }, end: { line: 1, character: 0 } })).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 1,
    });
  });

  it("turns snippets and text edits into Monaco completions", () => {
    const item = toCompletionItem(
      {
        label: "print_r",
        kind: 3,
        insertTextFormat: 2,
        textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "print_r(${1})" },
      },
      RANGE,
    );
    expect(item.kind).toBe(monaco.languages.CompletionItemKind.Function);
    expect(item.insertText).toBe("print_r(${1})");
    expect(item.insertTextRules).toBe(monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet);
    expect(item.range).toEqual(RANGE);
  });

  it("falls back to the label and the word range", () => {
    const item = toCompletionItem({ label: "self" }, RANGE);
    expect(item.insertText).toBe("self");
    expect(item.kind).toBe(monaco.languages.CompletionItemKind.Text);
    expect(item.insertTextRules).toBeUndefined();
  });

  it("renders every documentation shape as markdown", () => {
    expect(toMarkdown("plain")).toEqual([{ value: "plain" }]);
    expect(toMarkdown({ kind: "markdown", value: "**b**" })).toEqual([{ value: "**b**" }]);
    expect(toMarkdown({ language: "php", value: "echo 1;" })).toEqual([{ value: "```php\necho 1;\n```" }]);
    expect(toMarkdown({ kind: "plaintext", value: "a*b" })).toEqual([{ value: "a\\*b" }]);
  });

  it("accepts both location shapes", () => {
    const range = { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } };
    const [plain] = toLocations({ uri: "file:///ws/a.py", range });
    const [link] = toLocations([{ targetUri: "file:///ws/b.py", targetRange: range, targetSelectionRange: range }]);
    expect(plain.uri.path).toBe("/ws/a.py");
    expect(link.uri.path).toBe("/ws/b.py");
    expect(link.range.startLineNumber).toBe(3);
  });

  it("maps diagnostic severities", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    expect(toMarker({ range, message: "x", severity: 2 }).severity).toBe(monaco.MarkerSeverity.Warning);
    expect(toMarker({ range, message: "x" }).severity).toBe(monaco.MarkerSeverity.Error);
  });
});
