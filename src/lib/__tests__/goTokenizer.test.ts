import { describe, expect, it } from "vitest";
import * as monaco from "monaco-editor/editor/editor.api.js";
import { registerGoTokenizer } from "../editorTheme";

monaco.languages.register({ id: "go" });
registerGoTokenizer(monaco as unknown as Parameters<typeof registerGoTokenizer>[0]);

// "word:token" pairs for the non-whitespace tokens of one line, without the ".go" postfix.
function tokensOf(code: string): string[] {
  const [line] = monaco.editor.tokenize(code, "go");
  return line
    .map((token, i) => `${code.slice(token.offset, line[i + 1]?.offset ?? code.length).trim()}:${token.type.replace(/\.go$/, "")}`)
    .filter((pair) => !pair.startsWith(":"));
}

describe("Go tokenizer", () => {
  it("colours keywords, builtins, constants and calls", () => {
    const tokens = tokensOf("if err != nil { return fmt.Errorf(name, len(items), true) }");
    expect(tokens).toContain("if:keyword.if");
    expect(tokens).toContain("nil:constant");
    expect(tokens).toContain("true:constant");
    expect(tokens).toContain("len:function");
    expect(tokens).toContain("Errorf:method");
    expect(tokens).toContain("fmt:identifier");
  });

  it("treats sized numeric types like the other basic types", () => {
    const tokens = tokensOf("var n uint64 = 1_000");
    expect(tokens).toContain("uint64:keyword.uint64");
    expect(tokens).toContain("1_000:number");
  });

  it("reads Go number literals as one token", () => {
    expect(tokensOf("x := 0xFF_FF")).toContain("0xFF_FF:number.hex");
    expect(tokensOf("x := 0b1010")).toContain("0b1010:number.binary");
    expect(tokensOf("x := 0o755")).toContain("0o755:number.octal");
    expect(tokensOf("x := 1.5e3")).toContain("1.5e3:number.float");
    expect(tokensOf("x := 2i")).toContain("2i:number");
  });

  it("does not treat comparison operators as brackets", () => {
    const tokens = tokensOf("if a < b && c > d { }");
    expect(tokens).toContain("<:delimiter");
    expect(tokens).toContain(">:delimiter");
    expect(tokens.some((t) => t.startsWith("<:delimiter.angle") || t.startsWith(">:delimiter.angle"))).toBe(false);
  });

  it("keeps a raw string on one token per span", () => {
    expect(tokensOf("tag := `json:\"id\"`")).toContain('`json:"id"`:string');
  });
});
