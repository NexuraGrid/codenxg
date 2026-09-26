import * as monaco from "monaco-editor";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { LspClient } from "./client";
import {
  toCompletionItem,
  toLocations,
  toLspPosition,
  toMarkdown,
  toMarker,
  toMonacoEdit,
  toSignatureHelp,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspSignatureHelp,
  type LspTextEdit,
} from "./protocol";
import { lspSend, lspStart, lspStop } from "../tauri-api";
import { showDialog } from "../../state/dialogStore";

/** Monaco language ids served by an external language server. */
const SERVED_LANGUAGES = ["php", "python", "java"];
// Servers like jdtls hold hundreds of MB: stop them once their files are closed.
const IDLE_STOP_MS = 3 * 60 * 1000;

interface ServerCapabilities {
  textDocumentSync?: number | { change?: number };
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  hoverProvider?: unknown;
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  definitionProvider?: unknown;
  documentFormattingProvider?: unknown;
}

class LanguageSession {
  private client!: LspClient;
  private capabilities: ServerCapabilities = {};
  private readonly documents = new Map<monaco.editor.ITextModel, monaco.IDisposable>();
  private readonly providers: monaco.IDisposable[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  readonly ready: Promise<boolean>;

  constructor(
    readonly language: string,
    private readonly root: string,
    private readonly onStopped: (session: LanguageSession) => void,
  ) {
    this.ready = this.start();
  }

  private async start(): Promise<boolean> {
    this.client = new LspClient((json) => void lspSend(this.language, json).catch(() => {}), {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
    });

    try {
      await lspStart(this.language, (json) => this.client.receive(json));
    } catch (error) {
      void explainStartFailure(this.language, String(error));
      return false;
    }

    const rootUri = monaco.Uri.file(this.root).toString();
    const result = await this.client.request<{ capabilities: ServerCapabilities }>("initialize", {
      processId: null,
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: this.root.split("/").pop() ?? this.root }],
      capabilities: CLIENT_CAPABILITIES,
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
  }

  close(model: monaco.editor.ITextModel): void {
    const listener = this.documents.get(model);
    if (!listener) return;
    listener.dispose();
    this.documents.delete(model);
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
    for (const provider of this.providers) provider.dispose();
    this.providers.length = 0;
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
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model) monaco.editor.setModelMarkers(model, this.markerOwner, diagnostics.map(toMarker));
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
        return [{ uri, name: this.root.split("/").pop() ?? this.root }];
      }
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
  },
  workspace: { workspaceFolders: true, configuration: true },
};

const noticesShown = new Set<string>();
const savedListeners = new Set<(model: monaco.editor.ITextModel) => void>();

async function explainStartFailure(language: string, error: string) {
  // Once per language per session: not having a server is a choice, not an emergency.
  if (noticesShown.has(language)) return;
  noticesShown.add(language);
  const hint = error.match(/not-installed:(.*)$/)?.[1];
  if (!hint) {
    console.error(`[lsp ${language}]`, error);
    return;
  }
  const command = hint.split("   ")[0];
  const choice = await showDialog({
    title: `Smart completion for ${language} needs a language server`,
    message: `Install it from a terminal, then reopen the file:\n\n${hint}`,
    buttons: [
      { label: "Copy command", value: "copy", variant: "primary" },
      { label: "Not now", value: "later" },
    ],
    cancelValue: "later",
  });
  if (choice === "copy") await writeText(command).catch(console.error);
}

/**
 * Starts a language server the first time a file of its language opens in
 * this workspace, and keeps it fed with the open files. Returns a cleanup
 * that stops every server (switching projects, closing the window).
 */
export function connectLanguageServers(root: string): () => void {
  const sessions = new Map<string, LanguageSession>();

  function sessionFor(language: string): LanguageSession | undefined {
    if (!SERVED_LANGUAGES.includes(language)) return undefined;
    let session = sessions.get(language);
    if (!session) {
      session = new LanguageSession(language, root, (stopped) => {
        // A newer session for the language may already have replaced it.
        if (sessions.get(language) === stopped) sessions.delete(language);
      });
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
    savedListeners.delete(onSaved);
    for (const subscription of subscriptions) subscription.dispose();
    for (const session of [...sessions.values()]) session.stop();
  };
}

/** Tells servers a file was saved (some re-check only on save). */
export function notifySaved(model: monaco.editor.ITextModel): void {
  for (const listener of savedListeners) listener(model);
}
