import { describe, expect, it } from "vitest";
import * as monaco from "monaco-editor/editor/editor.api.js";
import { enhanceLanguage } from "../semanticHighlight";
import { language as python } from "monaco-editor/languages/definitions/python/python.js";
import { language as typescript } from "monaco-editor/languages/definitions/typescript/typescript.js";
import { language as java } from "monaco-editor/languages/definitions/java/java.js";
import { language as php } from "monaco-editor/languages/definitions/php/php.js";

// Returns "word:token" pairs for every non-whitespace token on the line,
// with the language postfix (".py", ".ts") stripped.
function tokensOf(languageId: string, code: string): string[] {
  const [line] = monaco.editor.tokenize(code, languageId);
  return line
    .map((token, i) => {
      const end = line[i + 1]?.offset ?? code.length;
      return `${code.slice(token.offset, end).trim()}:${token.type.replace(/\.(py|ts|java|php|python)$/, "")}`;
    })
    .filter((pair) => !pair.startsWith(":"));
}

function use(id: string, language: monaco.languages.IMonarchLanguage, accessor?: string) {
  monaco.languages.register({ id });
  monaco.languages.setMonarchTokensProvider(id, enhanceLanguage(language, accessor));
}

describe("enhanceLanguage", () => {
  it("tells functions, methods, properties, types and constants apart in Python", () => {
    use("py-test", python);
    const tokens = tokensOf("py-test", "x = MAX_SIZE + os.path.join(User(), load_config(1))");
    expect(tokens).toContain("MAX_SIZE:constant");
    expect(tokens).toContain("path:property");
    expect(tokens).toContain("join:method");
    expect(tokens).toContain("User:type.identifier");
    expect(tokens).toContain("load_config:function");
  });

  it("keeps keywords as keywords even when followed by a parenthesis", () => {
    use("ts-test", typescript);
    const tokens = tokensOf("ts-test", "if (ready) return fetchUser(id).then(render)");
    expect(tokens).toContain("if:keyword");
    expect(tokens).toContain("return:keyword");
    expect(tokens).toContain("fetchUser:function");
    expect(tokens).toContain("then:method");
  });

  it("colours Java classes, fields and calls", () => {
    use("java-test", java);
    const tokens = tokensOf("java-test", "System.out.println(new ArrayList())");
    expect(tokens).toContain("System:type.identifier");
    expect(tokens).toContain("out:property");
    expect(tokens).toContain("println:method");
    expect(tokens).toContain("new:keyword.new");
  });

  it("uses -> as the member accessor in PHP", () => {
    use("php-test", php, "\\?->|->|::");
    const [, phpLine] = monaco.editor.tokenize("<?php\n$this->repo->save($user);", "php-test");
    const code = "$this->repo->save($user);";
    const types = phpLine.map((t) => t.type);
    const words = phpLine.map((t, i) => code.slice(t.offset, phpLine[i + 1]?.offset ?? code.length));
    expect(types[words.indexOf("repo")]).toBe("property");
    expect(types[words.indexOf("save")]).toBe("method");
  });

  it("leaves a grammar without an identifier rule untouched", () => {
    const plain = { tokenizer: { root: [[/\d+/, "number"]] } } as monaco.languages.IMonarchLanguage;
    expect(enhanceLanguage(plain)).toBe(plain);
  });
});
