import type { Monaco } from "@monaco-editor/react";
import type * as monacoTypes from "monaco-editor";
import { enhanceLanguage } from "./semanticHighlight";

// Values copied from the approved design reference (diseñoEditor/styles.css).
const palette = {
  panel: "121212",
  text: "d4d4d4",
  textFaint: "535353",
  lineCurrent: "d6d6d6",
  kw: "7fa6f3",
  fn: "8ccf9c",
  str: "d9d0ea",
  com: "6b6b6b",
  num: "e2e2e2",
  // Not in the design reference: a quiet blue-grey so fields read apart from
  // locals without competing with keywords or calls.
  prop: "a8c0dc",
  b1: "e5bf6b",
  b2: "d27ed3",
  b3: "5ea8f0",
  caret: "6aa8ff",
  guide: "4a4a4a",
};

export const EDITOR_THEME_ID = "design-dark";

export function applyEditorTheme(monaco: Monaco) {
  monaco.editor.defineTheme(EDITOR_THEME_ID, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: palette.text },
      { token: "keyword", foreground: palette.kw },
      // Shapes added by semanticHighlight.ts: calls and methods share the
      // design's function green; types take gold, constants magenta.
      { token: "function", foreground: palette.fn },
      { token: "method", foreground: palette.fn },
      { token: "property", foreground: palette.prop },
      { token: "identifier", foreground: palette.text },
      { token: "string", foreground: palette.str },
      { token: "string.escape", foreground: palette.str },
      { token: "comment", foreground: palette.com },
      { token: "number", foreground: palette.num },
      { token: "delimiter", foreground: palette.text },
      { token: "operator", foreground: palette.text },
      // Other languages, mapped onto the same design palette so a YAML, JSON
      // or TS file doesn't fall back to vs-dark's unrelated colors.
      { token: "type", foreground: palette.b1 },
      { token: "type.identifier", foreground: palette.b1 },
      { token: "constructor.identifier", foreground: palette.b1 },
      { token: "tag", foreground: palette.kw },
      { token: "metatag", foreground: palette.b1 },
      { token: "annotation", foreground: palette.b1 },
      { token: "constant", foreground: palette.b2 },
      { token: "attribute.name", foreground: palette.fn },
      { token: "attribute.value", foreground: palette.str },
      { token: "string.key.json", foreground: palette.kw },
      { token: "string.value.json", foreground: palette.str },
      { token: "variable", foreground: palette.text },
      { token: "variable.predefined", foreground: palette.b3 },
      { token: "regexp", foreground: palette.b2 },
    ],
    colors: {
      "editor.background": `#${palette.panel}`,
      "editor.foreground": `#${palette.text}`,
      "editorLineNumber.foreground": `#${palette.textFaint}`,
      "editorLineNumber.activeForeground": `#${palette.lineCurrent}`,
      "editorCursor.foreground": `#${palette.caret}`,
      "editor.selectionBackground": "#3b82f633",
      "editor.lineHighlightBackground": "#00000000",
      "editor.lineHighlightBorder": "#00000000",
      "editorIndentGuide.background1": "#00000000",
      "editorIndentGuide.activeBackground1": `#${palette.guide}`,
      "editorOverviewRuler.border": "#00000000",
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": "#2e2e2ecc",
      "scrollbarSlider.hoverBackground": "#454545",
      "scrollbarSlider.activeBackground": "#3b82f6b3",
      // The design cycles three bracket colors; Monaco cycles six, so repeat.
      "editorBracketHighlight.foreground1": `#${palette.b1}`,
      "editorBracketHighlight.foreground2": `#${palette.b2}`,
      "editorBracketHighlight.foreground3": `#${palette.b3}`,
      "editorBracketHighlight.foreground4": `#${palette.b1}`,
      "editorBracketHighlight.foreground5": `#${palette.b2}`,
      "editorBracketHighlight.foreground6": `#${palette.b3}`,
      "editorBracketHighlight.unexpectedBracket.foreground": "#ff5555",
    },
  });
}

// Keywords and the basic types the design colors like keywords (int, string,
// error...). The rest of the language is layered on top: sized numeric types
// join them, true/false/nil/iota read as constants and the builtin functions
// (len, make, append...) as calls. Calls, members, types and ALL_CAPS
// constants come from enhanceLanguage, like every other language.
function goLanguage(): monacoTypes.languages.IMonarchLanguage {
  return {
    defaultToken: "",
    tokenPostfix: ".go",
    keywords: [
      "package", "import", "func", "var", "const", "type", "defer", "go",
      "for", "range", "return", "if", "else", "switch", "select", "case",
      "default", "break", "continue", "chan", "struct", "map", "interface",
      "fallthrough", "goto",
      "int", "string", "bool", "error", "byte", "rune", "float64",
      "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32",
      "uint64", "uintptr", "float32", "complex64", "complex128", "any", "comparable",
    ],
    constants: ["true", "false", "nil", "iota"],
    builtins: [
      "append", "cap", "clear", "close", "complex", "copy", "delete", "imag",
      "len", "make", "max", "min", "new", "panic", "print", "println", "real",
      "recover",
    ],
    operators: [
      "+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>", "&^", "+=", "-=",
      "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "&^=", "&&", "||",
      "<-", "++", "--", "==", "<", ">", "=", "!", "!=", "<=", ">=", ":=",
      "...",
    ],
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    tokenizer: {
      root: [
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              "@keywords": { token: "keyword.$0" },
              "@constants": "constant",
              "@builtins": "function",
              "@default": "identifier",
            },
          },
        ],
        { include: "@whitespace" },
        [/[{}()\[\]]/, "@brackets"],
        [/@symbols/, { cases: { "@operators": "delimiter", "@default": "" } }],
        // Go allows `_` between digits and an `i` suffix for imaginary values.
        [/0[xX][0-9a-fA-F_]+(?:\.[0-9a-fA-F_]*)?(?:[pP][\-+]?\d+)?i?/, "number.hex"],
        [/0[bB][01_]+i?/, "number.binary"],
        [/0[oO][0-7_]+i?/, "number.octal"],
        [/\d[\d_]*\.[\d_]*(?:[eE][\-+]?\d+)?i?/, "number.float"],
        [/\.\d[\d_]*(?:[eE][\-+]?\d+)?i?/, "number.float"],
        [/\d[\d_]*[eE][\-+]?\d+i?/, "number.float"],
        [/\d[\d_]*i?/, "number"],
        [/[;,.]/, "delimiter"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string"],
        [/`/, "string", "@rawstring"],
        [/'[^\\']'/, "string"],
        [/(')(@escapes)(')/, ["string", "string.escape", "string"]],
        [/'/, "string.invalid"],
      ],
      whitespace: [
        [/[ \t\r\n]+/, ""],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],
      comment: [
        [/[^\/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[\/*]/, "comment"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"],
      ],
      rawstring: [
        [/[^\`]+/, "string"],
        [/`/, "string", "@pop"],
      ],
    },
  };
}

export function registerGoTokenizer(monaco: Monaco) {
  monaco.languages.setMonarchTokensProvider("go", enhanceLanguage(goLanguage()));
}
