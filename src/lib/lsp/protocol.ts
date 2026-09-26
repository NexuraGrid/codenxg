import * as monaco from "monaco-editor";

// The slice of the LSP types this editor uses (spec 3.17).
export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}
export interface LspLocation {
  uri: string;
  range: LspRange;
}
export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}
export type LspMarkup = string | { kind?: string; language?: string; value: string };
export interface LspCompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  detail?: string;
  documentation?: LspMarkup;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: LspTextEdit | { newText: string; insert: LspRange; replace: LspRange };
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
  data?: unknown;
}
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}
export interface LspSignatureHelp {
  signatures: {
    label: string;
    documentation?: LspMarkup;
    parameters?: { label: string | [number, number]; documentation?: LspMarkup }[];
    activeParameter?: number;
  }[];
  activeSignature?: number;
  activeParameter?: number;
}

export const toLspPosition = (p: monaco.IPosition): LspPosition => ({
  line: p.lineNumber - 1,
  character: p.column - 1,
});

export const toMonacoRange = (r: LspRange): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});

export const toLspRange = (r: monaco.IRange): LspRange => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});

export const toMonacoEdit = (edit: LspTextEdit): monaco.languages.TextEdit => ({
  range: toMonacoRange(edit.range),
  text: edit.newText,
});

/** Markdown for Monaco from any of LSP's documentation shapes. */
export function toMarkdown(markup: LspMarkup | LspMarkup[] | undefined): monaco.IMarkdownString[] {
  if (markup === undefined) return [];
  if (Array.isArray(markup)) return markup.flatMap(toMarkdown);
  if (typeof markup === "string") return markup ? [{ value: markup }] : [];
  // MarkedString with a language is a code block; MarkupContent carries its kind.
  if (markup.language) return [{ value: `\`\`\`${markup.language}\n${markup.value}\n\`\`\`` }];
  if (!markup.value) return [];
  return [{ value: markup.kind === "plaintext" ? escapeMarkdown(markup.value) : markup.value }];
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

// LSP numbers its kinds from 1 in this order; Monaco names them the same.
const KIND_NAMES = [
  "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module",
  "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder",
  "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter",
] as const;

export function toCompletionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  const name = kind ? KIND_NAMES[kind - 1] : undefined;
  return monaco.languages.CompletionItemKind[name ?? "Text"];
}

export function toCompletionItem(
  item: LspCompletionItem,
  defaultRange: monaco.IRange,
): monaco.languages.CompletionItem {
  const edit = item.textEdit;
  const range = !edit
    ? defaultRange
    : "range" in edit
      ? toMonacoRange(edit.range)
      : { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) };
  const docs = toMarkdown(item.documentation)[0];

  return {
    label: item.labelDetails
      ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description }
      : item.label,
    kind: toCompletionKind(item.kind),
    detail: item.detail,
    documentation: docs,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    insertText: edit?.newText ?? item.insertText ?? item.label,
    // insertTextFormat 2 = snippet ("${1:name}" placeholders).
    insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range,
    additionalTextEdits: item.additionalTextEdits?.map(toMonacoEdit),
    commitCharacters: item.commitCharacters,
  };
}

export function toLocations(result: LspLocation | LspLocation[] | LspLocationLink[] | null): monaco.languages.Location[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((entry) =>
    "targetUri" in entry
      ? { uri: monaco.Uri.parse(entry.targetUri), range: toMonacoRange(entry.targetSelectionRange) }
      : { uri: monaco.Uri.parse(entry.uri), range: toMonacoRange(entry.range) },
  );
}

const SEVERITIES = [
  monaco.MarkerSeverity.Error,
  monaco.MarkerSeverity.Warning,
  monaco.MarkerSeverity.Info,
  monaco.MarkerSeverity.Hint,
];

export function toMarker(diagnostic: LspDiagnostic): monaco.editor.IMarkerData {
  return {
    ...toMonacoRange(diagnostic.range),
    severity: SEVERITIES[(diagnostic.severity ?? 1) - 1] ?? monaco.MarkerSeverity.Error,
    message: diagnostic.message,
    source: diagnostic.source,
    code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
  };
}

export function toSignatureHelp(help: LspSignatureHelp): monaco.languages.SignatureHelp {
  return {
    signatures: help.signatures.map((signature) => ({
      label: signature.label,
      documentation: toMarkdown(signature.documentation)[0],
      parameters: (signature.parameters ?? []).map((parameter) => ({
        label: parameter.label,
        documentation: toMarkdown(parameter.documentation)[0],
      })),
      activeParameter: signature.activeParameter,
    })),
    activeSignature: help.activeSignature ?? 0,
    activeParameter: help.activeParameter ?? 0,
  };
}
