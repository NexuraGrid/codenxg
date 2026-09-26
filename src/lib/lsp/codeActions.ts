// Pure mapping between LSP code actions/diagnostics and Monaco's shapes, plus
// the small capability checks that decide whether prepareRename /
// codeAction.resolve are worth calling. Kept Monaco-import-light (types only)
// so it's cheap to unit test.
import type * as monaco from "monaco-editor";
import type { LspCodeAction, LspCommand, LspDiagnostic, LspRange } from "./protocol";
import { toMarker } from "./protocol";

// -- Capabilities ---------------------------------------------------------

export type RenameProviderCapability = boolean | { prepareProvider?: boolean } | undefined;
export type CodeActionProviderCapability = boolean | { resolveProvider?: boolean; codeActionKinds?: string[] } | undefined;

export function supportsPrepareRename(renameProvider: RenameProviderCapability): boolean {
  return typeof renameProvider === "object" && renameProvider?.prepareProvider === true;
}

export function supportsCodeActionResolve(codeActionProvider: CodeActionProviderCapability): boolean {
  return typeof codeActionProvider === "object" && codeActionProvider?.resolveProvider === true;
}

export function providedCodeActionKinds(codeActionProvider: CodeActionProviderCapability): string[] | undefined {
  return typeof codeActionProvider === "object" ? codeActionProvider.codeActionKinds : undefined;
}

// -- Diagnostics ------------------------------------------------------------

function rangesOverlap(a: LspRange, b: LspRange): boolean {
  const startsBeforeOtherEnds = a.start.line < b.end.line || (a.start.line === b.end.line && a.start.character <= b.end.character);
  const endsAfterOtherStarts = a.end.line > b.start.line || (a.end.line === b.start.line && a.end.character >= b.start.character);
  return startsBeforeOtherEnds && endsAfterOtherStarts;
}

/** The diagnostics a `textDocument/codeAction` request for `range` should carry as context. */
export function diagnosticsInRange(diagnostics: LspDiagnostic[], range: LspRange): LspDiagnostic[] {
  return diagnostics.filter((d) => rangesOverlap(d.range, range));
}

// -- Code actions / commands -------------------------------------------------

/** A bare LSP `Command` result, as opposed to a full `CodeAction`. */
function isBareCommand(item: LspCodeAction | LspCommand): item is LspCommand {
  return typeof (item as LspCommand).command === "string";
}

/** `textDocument/codeAction` results are `(Command | CodeAction)[]`; normalize both to `CodeAction`. */
export function normalizeCodeActionResult(item: LspCodeAction | LspCommand): LspCodeAction {
  return isBareCommand(item) ? { title: item.title, command: item } : item;
}

/**
 * Maps one LSP CodeAction to Monaco's shape. Deliberately never sets `edit`
 * or a plain Monaco `command` object: this editor applies workspace edits
 * and executes server commands itself (see applyEdit.ts), because Monaco's
 * built-in bulk-edit service can only touch files it already has a model
 * for. The action is instead routed through one synthetic command that
 * carries the raw LSP action as its argument.
 */
export function toMonacoCodeAction(action: LspCodeAction, applyCommandId: string): monaco.languages.CodeAction {
  return {
    title: action.title,
    kind: action.kind,
    isPreferred: action.isPreferred,
    disabled: action.disabled?.reason,
    diagnostics: action.diagnostics?.map(toMarker),
    command: { id: applyCommandId, title: action.title, arguments: [action] },
  };
}
