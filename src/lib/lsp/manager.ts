import * as monaco from "monaco-editor";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { LspClient } from "./client";
import {
  toCompletionItem,
  toLocations,
  toLspPosition,
  toLspRange,
  toMarkdown,
  toMarker,
  toMonacoEdit,
  toSignatureHelp,
  type LspCodeAction,
  type LspCommand,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspRenameLocation,
  type LspSignatureHelp,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from "./protocol";
import {
  diagnosticsInRange,
  normalizeCodeActionResult,
  providedCodeActionKinds,
  supportsCodeActionResolve,
  supportsPrepareRename,
  toMonacoCodeAction,
  type CodeActionProviderCapability,
  type RenameProviderCapability,
} from "./codeActions";
import { applyWorkspaceEdit } from "./applyEdit";
import {
  INITIALIZATION_OPTIONS,
  SEMANTIC_LANGUAGES,
  SEMANTIC_TOKENS_CAPABILITY,
  semanticLegend,
  toSemanticTokenData,
  type SemanticTokensProviderCapability,
} from "./semanticTokens";
import { ensureModelsForLocations, releaseUnusedLoanedModels } from "./referenceModels";
import { toRenameLocation } from "./rename";
import type { ResourceOperation } from "./workspaceEdit";
import { lspInstall, lspSend, lspStart, lspStop, type LspStarted } from "../tauri-api";
import { basename, pathFromUri } from "../paths";
import { showDialog, useDialogStore, type DialogRequest } from "../../state/dialogStore";
import { parseStartFailure, parseToolMissing, type MissingTool } from "./startFailure";
import { SERVED_LANGUAGES } from "./servedLanguages";

// Servers like jdtls hold hundreds of MB: stop them once their files are closed.
const IDLE_STOP_MS = 3 * 60 * 1000;

interface ServerCapabilities {
  textDocumentSync?: number | { change?: number };
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  hoverProvider?: unknown;
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  definitionProvider?: unknown;
  documentFormattingProvider?: unknown;
  renameProvider?: RenameProviderCapability;
  referencesProvider?: unknown;
  codeActionProvider?: CodeActionProviderCapability;
  semanticTokensProvider?: SemanticTokensProviderCapability;
}

class LanguageSession {
  private client!: LspClient;
  private capabilities: ServerCapabilities = {};
  // Monaco asks for semantic tokens as soon as a provider exists, which is
  // before the server has been told about the file; this makes it ask again.
  private readonly semanticTokensChanged = new monaco.Emitter<void>();
  private readonly documents = new Map<monaco.editor.ITextModel, monaco.IDisposable>();
  private readonly providers: monaco.IDisposable[] = [];
  // Raw (pre-toMarker) diagnostics per model, so code actions can hand the
  // server back its own diagnostic objects — including their opaque `data`,
  // which toMarker's monaco.editor.IMarkerData shape can't carry.
  private readonly diagnosticsByModel = new Map<monaco.editor.ITextModel, LspDiagnostic[]>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  readonly ready: Promise<boolean>;

  constructor(
    readonly language: string,
    private readonly root: string,
    private readonly onStopped: (session: LanguageSession) => void,
    /** Starts over (new session, open files re-sent) — after a one-click install. */
    private readonly restart: () => void,
  ) {
    this.ready = this.start();
  }

  private async start(): Promise<boolean> {
    this.client = new LspClient((json) => void lspSend(this.language, json).catch(() => {}), {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
    });

    let started: LspStarted;
    try {
      started = await lspStart(this.language, (json) => this.client.receive(json));
    } catch (error) {
      void explainStartFailure(this.language, String(error), this.restart);
      return false;
    }

    const rootUri = monaco.Uri.file(this.root).toString();
    const result = await this.client.request<{ capabilities: ServerCapabilities }>("initialize", {
      processId: null,
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: basename(this.root) }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: started.initializationOptions ?? INITIALIZATION_OPTIONS[this.language],
    });
    this.capabilities = result.capabilities ?? {};
    this.client.notify("initialized", {});
    this.registerProviders();
    return true;
  }

  // Full or incremental sync, as the server asked (1 = full, 2 = incremental).
  private get syncKind(): number {
    const sync = this.capabilities.textDocumentSync;
    return typeof sync === "number" ? sync : (sync?.change ?? 1);
  }

  open(model: monaco.editor.ITextModel): void {
    if (this.documents.has(model)) return;
    clearTimeout(this.idleTimer);
    const uri = model.uri.toString();
    this.client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: this.language, version: model.getVersionId(), text: model.getValue() },
    });
    const listener = model.onDidChangeContent((event) => {
      const contentChanges =
        this.syncKind === 2
          ? event.changes.map((change) => ({
              range: {
                start: toLspPosition({ lineNumber: change.range.startLineNumber, column: change.range.startColumn }),
                end: toLspPosition({ lineNumber: change.range.endLineNumber, column: change.range.endColumn }),
              },
              text: change.text,
            }))
          : [{ text: model.getValue() }];
      this.client.notify("textDocument/didChange", {
        textDocument: { uri, version: model.getVersionId() },
        contentChanges,
      });
    });
    this.documents.set(model, listener);
    this.semanticTokensChanged.fire();
  }

  close(model: monaco.editor.ITextModel): void {
    const listener = this.documents.get(model);
    if (!listener) return;
    listener.dispose();
    this.documents.delete(model);
    this.diagnosticsByModel.delete(model);
    this.client.notify("textDocument/didClose", { textDocument: { uri: model.uri.toString() } });
    monaco.editor.setModelMarkers(model, this.markerOwner, []);
    if (this.documents.size === 0) this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
  }

  saved(model: monaco.editor.ITextModel): void {
    if (this.documents.has(model)) {
      this.client.notify("textDocument/didSave", { textDocument: { uri: model.uri.toString() } });
    }
  }

  /** Idempotent: our own kill is later echoed back as a "server exited" message. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer);
    for (const [model, listener] of this.documents) {
      listener.dispose();
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, this.markerOwner, []);
    }
    this.documents.clear();
    this.diagnosticsByModel.clear();
    releaseUnusedLoanedModels();
    for (const provider of this.providers) provider.dispose();
    this.providers.length = 0;
    this.semanticTokensChanged.dispose();
    this.client.close();
    void lspStop(this.language).catch(() => {});
    this.onStopped(this);
  }

  private get markerOwner() {
    return `lsp-${this.language}`;
  }

  private onNotification(method: string, params: unknown) {
    if (method === "textDocument/publishDiagnostics") {
      const { uri, diagnostics } = params as { uri: string; diagnostics: LspDiagnostic[] };
      // Re-encode through our canonical path form: a server is free to send
      // back a differently-cased drive letter than the one our own model's
      // Uri was created with, which would otherwise miss on Windows.
      const model = monaco.editor.getModel(monaco.Uri.file(pathFromUri(monaco.Uri.parse(uri))));
      if (model) {
        this.diagnosticsByModel.set(model, diagnostics);
        monaco.editor.setModelMarkers(model, this.markerOwner, diagnostics.map(toMarker));
      }
    } else if (method === "$/codenxg/serverExited") {
      // Crashed or killed from outside: forget it; the next file starts a new one.
      this.stop();
    }
  }

  private onRequest(method: string, params: unknown): unknown {
    switch (method) {
      case "workspace/configuration":
        // "Use your defaults" for every requested section.
        return ((params as { items?: unknown[] }).items ?? []).map(() => null);
      case "workspace/workspaceFolders": {
        const uri = monaco.Uri.file(this.root).toString();
        return [{ uri, name: basename(this.root) }];
      }
      case "workspace/applyEdit":
        // The server pushing its own edits back (e.g. after executeCommand).
        return applyWorkspaceEdit((params as { edit: LspWorkspaceEdit }).edit)
          .then((result) => ({ applied: true, ...(result.skippedOperations.length ? { failureReason: "unsupported file operation" } : {}) }))
          .catch((error: unknown) => ({ applied: false, failureReason: String(error) }));
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
        return null;
      default:
        return undefined;
    }
  }

  private registerProviders() {
    const caps = this.capabilities;
    const language = this.language;
    const request = <T>(method: string, model: monaco.editor.ITextModel, extra: object, token?: monaco.CancellationToken) =>
      this.client.request<T>(method, { textDocument: { uri: model.uri.toString() }, ...extra }, token);

    if (caps.completionProvider) {
      const resolvable = new WeakMap<monaco.languages.CompletionItem, LspCompletionItem>();
      this.providers.push(
        monaco.languages.registerCompletionItemProvider(language, {
          triggerCharacters: caps.completionProvider.triggerCharacters,
          provideCompletionItems: async (model, position, context, token) => {
            const result = await request<LspCompletionItem[] | { items: LspCompletionItem[]; isIncomplete?: boolean } | null>(
              "textDocument/completion",
              model,
              {
                position: toLspPosition(position),
                context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter },
              },
              token,
            ).catch(() => null);
            if (!result) return { suggestions: [] };
            const items = Array.isArray(result) ? result : result.items;
            const word = model.getWordUntilPosition(position);
            const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
            const suggestions = items.map((item) => {
              const suggestion = toCompletionItem(item, range);
              resolvable.set(suggestion, item);
              return suggestion;
            });
            return { suggestions, incomplete: !Array.isArray(result) && result.isIncomplete };
          },
          resolveCompletionItem: caps.completionProvider.resolveProvider
            ? async (suggestion, token) => {
                const item = resolvable.get(suggestion);
                if (!item) return suggestion;
                const resolved = await this.client
                  .request<LspCompletionItem>("completionItem/resolve", item, token)
                  .catch(() => null);
                if (!resolved) return suggestion;
                return {
                  ...suggestion,
                  detail: resolved.detail ?? suggestion.detail,
                  documentation: toMarkdown(resolved.documentation)[0] ?? suggestion.documentation,
                  additionalTextEdits: resolved.additionalTextEdits?.map(toMonacoEdit) ?? suggestion.additionalTextEdits,
                };
              }
            : undefined,
        }),
      );
    }

    const legend = SEMANTIC_LANGUAGES.includes(language) ? semanticLegend(caps.semanticTokensProvider) : null;
    if (legend) {
      this.providers.push(
        monaco.languages.registerDocumentSemanticTokensProvider(language, {
          onDidChange: this.semanticTokensChanged.event,
          getLegend: () => legend,
          provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
            const result = await request<{ data?: number[] } | null>("textDocument/semanticTokens/full", model, {}, token).catch(
              () => null,
            );
            const data = toSemanticTokenData(result);
            return data ? { data } : null;
          },
          releaseDocumentSemanticTokens: () => {},
        }),
      );
    }

    if (caps.hoverProvider) {
      this.providers.push(
        monaco.languages.registerHoverProvider(language, {
          provideHover: async (model, position, token) => {
            const hover = await request<{ contents: Parameters<typeof toMarkdown>[0] } | null>(
              "textDocument/hover",
              model,
              { position: toLspPosition(position) },
              token,
            ).catch(() => null);
            const contents = hover ? toMarkdown(hover.contents) : [];
            return contents.length ? { contents } : null;
          },
        }),
      );
    }

    if (caps.signatureHelpProvider) {
      this.providers.push(
        monaco.languages.registerSignatureHelpProvider(language, {
          signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters ?? ["(", ","],
          signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters,
          provideSignatureHelp: async (model, position, token) => {
            const help = await request<LspSignatureHelp | null>(
              "textDocument/signatureHelp",
              model,
              { position: toLspPosition(position) },
              token,
            ).catch(() => null);
            if (!help?.signatures.length) return null;
            return { value: toSignatureHelp(help), dispose: () => {} };
          },
        }),
      );
    }

    if (caps.definitionProvider) {
      this.providers.push(
        monaco.languages.registerDefinitionProvider(language, {
          provideDefinition: async (model, position, token) =>
            toLocations(
              await request<Parameters<typeof toLocations>[0]>(
                "textDocument/definition",
                model,
                { position: toLspPosition(position) },
                token,
              ).catch(() => null),
            ),
        }),
      );
    }

    if (caps.documentFormattingProvider) {
      this.providers.push(
        monaco.languages.registerDocumentFormattingEditProvider(language, {
          provideDocumentFormattingEdits: async (model, options, token) => {
            const edits = await request<LspTextEdit[] | null>(
              "textDocument/formatting",
              model,
              { options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } },
              token,
            ).catch(() => null);
            return (edits ?? []).map(toMonacoEdit);
          },
        }),
      );
    }

    if (caps.renameProvider) {
      this.providers.push(
        monaco.languages.registerRenameProvider(language, {
          resolveRenameLocation: supportsPrepareRename(caps.renameProvider)
            ? async (model, position, token) => {
                const result = await request<LspRenameLocation | null>(
                  "textDocument/prepareRename",
                  model,
                  { position: toLspPosition(position) },
                  token,
                ).catch(() => null);
                // Monaco's own type requires range/text even on a rejection,
                // but its rename widget only ever reads rejectReason there.
                return toRenameLocation(
                  result,
                  position,
                  (pos) => {
                    const word = model.getWordAtPosition(pos);
                    if (!word) return null;
                    return {
                      range: new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn),
                      text: word.word,
                    };
                  },
                  (range) => model.getValueInRange(range),
                ) as monaco.languages.RenameLocation & monaco.languages.Rejection;
              }
            : undefined,
          provideRenameEdits: async (model, position, newName, token) => {
            let edit: LspWorkspaceEdit | null;
            try {
              edit = await request<LspWorkspaceEdit | null>(
                "textDocument/rename",
                model,
                { position: toLspPosition(position), newName },
                token,
              );
            } catch (error) {
              return { edits: [], rejectReason: String(error) };
            }
            // We apply the edit ourselves (see applyEdit.ts) instead of
            // letting Monaco's bulk-edit service handle the returned
            // WorkspaceEdit: that service can only touch files it already
            // has a model for, so a rename that reaches an unopened file
            // would silently fail for that file. Returning no edits tells
            // Monaco there's nothing left for it to do.
            const { skippedOperations } = await applyWorkspaceEdit(edit);
            if (skippedOperations.length) void warnAboutSkippedOperations(skippedOperations);
            return { edits: [] };
          },
        }),
      );
    }

    if (caps.referencesProvider) {
      this.providers.push(
        monaco.languages.registerReferenceProvider(language, {
          provideReferences: async (model, position, context, token) => {
            const result = await request<Parameters<typeof toLocations>[0]>(
              "textDocument/references",
              model,
              { position: toLspPosition(position), context: { includeDeclaration: context.includeDeclaration } },
              token,
            ).catch(() => null);
            const locations = toLocations(result);
            // Peek needs a model for every result up front to show previews.
            await ensureModelsForLocations(locations);
            return locations;
          },
        }),
      );
    }

    if (caps.codeActionProvider) {
      const applyCommandId = `codenxg.codeAction.apply.${language}`;
      this.providers.push(monaco.editor.registerCommand(applyCommandId, (_accessor, action: LspCodeAction) => this.runCodeAction(action)));
      this.providers.push(
        monaco.languages.registerCodeActionProvider(
          language,
          {
            provideCodeActions: async (model, range, context, token) => {
              const rawDiagnostics = this.diagnosticsByModel.get(model) ?? [];
              const lspRange = toLspRange(range);
              const result = await request<(LspCodeAction | LspCommand)[] | null>(
                "textDocument/codeAction",
                model,
                {
                  range: lspRange,
                  context: {
                    diagnostics: diagnosticsInRange(rawDiagnostics, lspRange),
                    only: context.only ? [context.only] : undefined,
                  },
                },
                token,
              ).catch(() => null);
              const actions = (result ?? [])
                .map(normalizeCodeActionResult)
                .map((action) => toMonacoCodeAction(action, applyCommandId));
              return { actions, dispose: () => {} };
            },
          },
          { providedCodeActionKinds: providedCodeActionKinds(caps.codeActionProvider) },
        ),
      );
    }
  }

  /** Runs one code action the user picked from the quick-fix menu. */
  private async runCodeAction(action: LspCodeAction): Promise<void> {
    let resolved = action;
    if (!action.edit && !action.command && supportsCodeActionResolve(this.capabilities.codeActionProvider)) {
      resolved = await this.client.request<LspCodeAction>("codeAction/resolve", action).catch(() => action);
    }

    if (resolved.edit) {
      const { skippedOperations } = await applyWorkspaceEdit(resolved.edit);
      if (skippedOperations.length) void warnAboutSkippedOperations(skippedOperations);
    }

    if (resolved.command) {
      await this.client
        .request("workspace/executeCommand", { command: resolved.command.command, arguments: resolved.command.arguments })
        .catch((error: unknown) =>
          showDialog({
            title: "Quick fix failed",
            message: String(error),
            buttons: [{ label: "OK", value: "ok", variant: "primary" }],
            cancelValue: "ok",
          }),
        );
    }
  }
}

const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        labelDetailsSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
      },
    },
    hover: { contentFormat: ["markdown", "plaintext"] },
    signatureHelp: {
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        parameterInformation: { labelOffsetSupport: true },
      },
    },
    definition: { linkSupport: true },
    formatting: {},
    publishDiagnostics: {},
    semanticTokens: SEMANTIC_TOKENS_CAPABILITY,
    rename: { prepareSupport: true },
    references: {},
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"],
        },
      },
      isPreferredSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ["edit"] },
    },
  },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    applyEdit: true,
    workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
  },
};

const noticesShown = new Set<string>();
const savedListeners = new Set<(model: monaco.editor.ITextModel) => void>();

/** Best-effort notice when a WorkspaceEdit asked for a create/rename/delete
 * file operation this editor doesn't perform (see applyEdit.ts). */
async function warnAboutSkippedOperations(operations: ResourceOperation[]): Promise<void> {
  const summary = operations.map((op) => (op.kind === "rename" ? `rename ${op.uri} -> ${op.newUri}` : `${op.kind} ${op.uri}`)).join("\n");
  await showDialog({
    title: "Some file changes were not applied",
    message: `The language server also asked to:\n\n${summary}\n\nThis editor doesn't perform file create/rename/delete from a language server yet — do it manually if needed.`,
    buttons: [{ label: "OK", value: "ok", variant: "primary" }],
    cancelValue: "ok",
  });
}

async function explainStartFailure(language: string, error: string, restart: () => void) {
  // Once per language per session: not having a server is a choice, not an emergency.
  if (noticesShown.has(language)) return;
  noticesShown.add(language);
  const tool = parseToolMissing(error);
  if (tool) {
    // The server is there but can't run (jdtls without a new enough Java).
    await explainMissingTool(language, tool);
    return;
  }
  const missing = parseStartFailure(error);
  if (!missing) {
    console.error(`[lsp ${language}]`, error);
    return;
  }
  const title = `Smart completion for ${language} needs a language server`;
  if (!missing.installable) {
    const choice = await showDialog({
      title,
      message: `Install it from a terminal, then reopen the file:\n\n${missing.hint}`,
      buttons: [
        { label: "Copy command", value: "copy", variant: "primary" },
        { label: "Not now", value: "later" },
      ],
      cancelValue: "later",
    });
    if (choice === "copy") await copyCommand(missing.command);
    return;
  }

  const choice = await showDialog({
    title,
    message: `Install it now? ${describeInstall(missing.command)}`,
    buttons: [
      { label: "Install", value: "install", variant: "primary" },
      { label: "Copy command", value: "copy" },
      { label: "Cancel", value: "cancel" },
    ],
    cancelValue: "cancel",
  });
  if (choice === "copy") await copyCommand(missing.command);
  if (choice === "install") await installServer(language, missing.command, restart);
}

/**
 * Explains that `tool` must be installed first. `command` is the server's
 * install, offered for copying when it's something to run in a terminal.
 */
async function explainMissingTool(language: string, tool: MissingTool, command?: string): Promise<void> {
  const runnable = command && !command.startsWith("download ") ? command : undefined;
  const next = runnable ? `then run:\n\n${runnable}` : "then reopen the file to try again.";
  const choice = await showDialog({
    title: `${tool.requires.split(" (")[0]} is required`,
    message: `The ${language} language server needs ${tool.requires}. Install it, ${next}`,
    buttons: runnable
      ? [
          { label: "Copy command", value: "copy", variant: "primary" },
          { label: "Close", value: "close" },
        ]
      : [{ label: "Close", value: "close", variant: "primary" }],
    cancelValue: "close",
  });
  if (choice === "copy" && runnable) await copyCommand(runnable);
}

// jdtls isn't a command but a download (see lsp.rs RECIPES).
function describeInstall(command: string): string {
  return command.startsWith("download ")
    ? `This downloads the official build into the app's data folder:\n\n${command.slice("download ".length)}`
    : `This runs:\n\n${command}`;
}

async function copyCommand(command: string): Promise<void> {
  await writeText(command).catch(console.error);
}

/** Runs the one-click install; on success the server starts for the open files. */
async function installServer(language: string, command: string, restart: () => void): Promise<void> {
  // "Hide" only dismisses the dialog: the install keeps running.
  const progress: DialogRequest<"hide"> = {
    title: `Installing the ${language} language server…`,
    message: describeInstall(command),
    buttons: [{ label: "Hide", value: "hide" }],
    cancelValue: "hide",
    busy: true,
  };
  void showDialog(progress);

  try {
    await lspInstall(language);
  } catch (error) {
    const reason = String(error);
    const tool = parseToolMissing(reason);
    if (tool) {
      await explainMissingTool(language, tool, command);
      return;
    }
    const choice = await showDialog({
      title: `Couldn't install the ${language} language server`,
      message: `${reason}\n\nYou can run it yourself from a terminal:\n\n${command}`,
      buttons: [
        { label: "Copy command", value: "copy", variant: "primary" },
        { label: "Close", value: "close" },
      ],
      cancelValue: "close",
    });
    if (choice === "copy") await copyCommand(command);
    return;
  }

  const { current, close } = useDialogStore.getState();
  if (current?.request === progress) close("hide");
  // A still-missing server after this (e.g. npm's global bin isn't where we
  // look) should be explained again rather than fail silently.
  noticesShown.delete(language);
  restart();
}

/**
 * Starts a language server the first time a file of its language opens in
 * this workspace, and keeps it fed with the open files. Returns a cleanup
 * that stops every server (switching projects, closing the window).
 */
export function connectLanguageServers(root: string): () => void {
  const sessions = new Map<string, LanguageSession>();
  let disconnected = false;

  function sessionFor(language: string): LanguageSession | undefined {
    if (!SERVED_LANGUAGES.includes(language)) return undefined;
    let session = sessions.get(language);
    if (!session) {
      session = new LanguageSession(
        language,
        root,
        (stopped) => {
          // A newer session for the language may already have replaced it.
          if (sessions.get(language) === stopped) sessions.delete(language);
        },
        () => restart(language),
      );
      sessions.set(language, session);
    }
    return session;
  }

  function track(model: monaco.editor.ITextModel) {
    // Only real files: diff views and commit views use in-memory models.
    if (model.uri.scheme !== "file") return;
    const session = sessionFor(model.getLanguageId());
    session?.ready.then((ok) => ok && !model.isDisposed() && session.open(model));
  }

  // Drops the (failed) session and starts a fresh one for the files already open.
  function restart(language: string) {
    if (disconnected) return;
    sessions.get(language)?.stop();
    for (const model of monaco.editor.getModels()) {
      if (!model.isDisposed() && model.getLanguageId() === language) track(model);
    }
  }

  function untrack(model: monaco.editor.ITextModel, language = model.getLanguageId()) {
    sessions.get(language)?.close(model);
  }

  const onSaved = (model: monaco.editor.ITextModel) => sessions.get(model.getLanguageId())?.saved(model);
  savedListeners.add(onSaved);

  const subscriptions = [
    monaco.editor.onDidCreateModel(track),
    monaco.editor.onWillDisposeModel((model) => untrack(model)),
    // A rename can change the language (notes.txt -> notes.py).
    monaco.editor.onDidChangeModelLanguage(({ model, oldLanguage }) => {
      untrack(model, oldLanguage);
      track(model);
    }),
  ];
  for (const model of monaco.editor.getModels()) track(model);

  return () => {
    disconnected = true;
    savedListeners.delete(onSaved);
    for (const subscription of subscriptions) subscription.dispose();
    for (const session of [...sessions.values()]) session.stop();
  };
}

/** Tells servers a file was saved (some re-check only on save). */
export function notifySaved(model: monaco.editor.ITextModel): void {
  for (const listener of savedListeners) listener(model);
}
