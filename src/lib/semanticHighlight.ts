import type * as monacoTypes from "monaco-editor";

type Monaco = typeof monacoTypes;
type Language = monacoTypes.languages.IMonarchLanguage;
type Rule = [RegExp | string, unknown, ...unknown[]];

interface CasesAction {
  cases: Record<string, unknown>;
}

/**
 * Monaco's grammars (Monarch) tag most names as a plain "identifier", so a
 * function call, a property and a local variable all look the same. This adds
 * rules in front of each grammar's identifier rule that tell them apart by
 * shape — the same cues a reader uses:
 *
 *   obj.method(   -> method        FOO_BAR -> constant
 *   obj.field     -> property      Foo     -> type (classes, interfaces)
 *   name(         -> function
 *
 * The new rules reuse the grammar's own keyword `cases`, so `if (` or `for (`
 * stay keywords. Grammars without a recognisable identifier rule are left as
 * they are.
 */
export function enhanceLanguage(language: Language, accessor = "\\."): Language {
  for (const [stateName, rules] of Object.entries(language.tokenizer)) {
    const index = rules.findIndex(isIdentifierRule);
    if (index === -1) continue;

    const identifierRule = rules[index] as Rule;
    const extra = shapeRules(identifierRule, accessor);
    const nextRules = [...rules.slice(0, index), ...extra, ...rules.slice(index)] as typeof rules;
    return { ...language, tokenizer: { ...language.tokenizer, [stateName]: nextRules } };
  }
  return language;
}

function shapeRules([regex, action]: Rule, accessor: string): Rule[] {
  const cases = (action as CasesAction).cases;
  const name = "[a-zA-Z_$][\\w$]*";
  const identifier = typeof regex === "string" ? regex : regex.source;
  const withDefault = (token: string) => ({ cases: { ...cases, "@default": replaceToken(cases["@default"], token) } });

  return [
    [new RegExp(`(${accessor})(\\s*)(${name})(?=\\s*\\()`), ["delimiter", "", "method"]],
    [new RegExp(`(${accessor})(\\s*)(${name})`), ["delimiter", "", "property"]],
    // Two or more characters: a lone capital (C++'s R"(...)", generics' T) isn't a constant.
    [/[A-Z][A-Z0-9_]*[A-Z0-9](?![\w$])/, withDefault("constant")],
    // Not followed by a quote: C++ R"..." / L"..." are string prefixes.
    [/[A-Z][\w$]*(?![\w$"'])/, withDefault("type.identifier")],
    [new RegExp(`(?:${identifier})(?=\\s*\\()`), withDefault("function")],
  ];
}

// The grammar's catch-all for names: a regex starting with a letter class and
// an action whose `cases` fall back to a default token.
function isIdentifierRule(rule: unknown): boolean {
  if (!Array.isArray(rule) || rule.length < 2) return false;
  const [regex, action] = rule as Rule;
  const source = typeof regex === "string" ? regex : regex instanceof RegExp ? regex.source : "";
  const cases = (action as Partial<CasesAction> | null)?.cases;
  return /^(\\@\?|#\?)?\[(a-zA-Z|a-z)/.test(source) && !!cases && "@default" in cases;
}

function replaceToken(action: unknown, token: string): unknown {
  if (typeof action === "string") return token;
  if (action && typeof action === "object") return { ...action, token };
  return token;
}

// Loaded only when a file of that language is first opened. Accessors are
// what reaches a member in each language (PHP's ->, C++'s -> and ::).
const GRAMMARS: Record<string, { load: () => Promise<{ language: Language }>; accessor?: string }> = {
  typescript: { load: () => import("monaco-editor/languages/definitions/typescript/typescript.js") },
  javascript: { load: () => import("monaco-editor/languages/definitions/javascript/javascript.js") },
  python: { load: () => import("monaco-editor/languages/definitions/python/python.js") },
  java: { load: () => import("monaco-editor/languages/definitions/java/java.js") },
  kotlin: { load: () => import("monaco-editor/languages/definitions/kotlin/kotlin.js") },
  csharp: { load: () => import("monaco-editor/languages/definitions/csharp/csharp.js") },
  cpp: { load: () => import("monaco-editor/languages/definitions/cpp/cpp.js"), accessor: "\\.|->|::" },
  c: { load: () => import("monaco-editor/languages/definitions/cpp/cpp.js"), accessor: "\\.|->" },
  rust: { load: () => import("monaco-editor/languages/definitions/rust/rust.js") },
  dart: { load: () => import("monaco-editor/languages/definitions/dart/dart.js") },
  php: { load: () => import("monaco-editor/languages/definitions/php/php.js"), accessor: "\\?->|->|::" },
};

/**
 * Swaps in the enhanced grammar the first time each language is used. A
 * provider set with setMonarchTokensProvider wins over Monaco's lazy one, and
 * open models re-tokenize when it arrives.
 */
export function registerSemanticHighlighting(monaco: Monaco): void {
  for (const [languageId, { load, accessor }] of Object.entries(GRAMMARS)) {
    monaco.languages.onLanguageEncountered(languageId, () => {
      load()
        .then(({ language }) => {
          monaco.languages.setMonarchTokensProvider(languageId, enhanceLanguage(language, accessor));
        })
        .catch(console.error);
    });
  }
}
