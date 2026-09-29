type Id = number | string;

interface Message {
  jsonrpc: "2.0";
  id?: Id | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Cancellable {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose(): void };
}

export interface ClientHandlers {
  onNotification: (method: string, params: unknown) => void;
  /**
   * Answers a request from the server; undefined means "not supported". May
   * return a Promise (e.g. `workspace/applyEdit`, which applies edits before
   * answering) — the response is sent once it settles.
   */
  onRequest: (method: string, params: unknown) => unknown;
}

const METHOD_NOT_FOUND = -32601;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function";
}

/**
 * JSON-RPC 2.0 over any string transport: `send` delivers one message to the
 * server, `receive` is fed every message coming back.
 */
export class LspClient {
  private nextId = 1;
  private readonly pending = new Map<Id, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private closed = false;

  constructor(
    private readonly send: (json: string) => void,
    private readonly handlers: ClientHandlers,
  ) {}

  request<T>(method: string, params: unknown, token?: Cancellable): Promise<T> {
    if (this.closed) return Promise.reject(new Error("language server stopped"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // Assigned after the pending entry exists, but read by its callbacks, so it
      // cannot be a const declared further down.
      // eslint-disable-next-line prefer-const
      let subscription: { dispose(): void } | undefined;
      this.pending.set(id, {
        resolve: (value) => {
          subscription?.dispose();
          resolve(value as T);
        },
        reject: (error) => {
          subscription?.dispose();
          reject(error);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
      // Monaco cancels requests the user moved past (kept typing, left the hover).
      subscription = token?.onCancellationRequested(() => {
        if (!this.pending.delete(id)) return;
        this.notify("$/cancelRequest", { id });
        reject(new Error("cancelled"));
      });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }

  receive(raw: string): void {
    let message: Message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.method === undefined) {
      // A response to one of our requests.
      const waiter = message.id == null ? undefined : this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id!);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result ?? null);
    } else if (message.id != null) {
      this.answer(message.id, message.method, message.params);
    } else {
      this.handlers.onNotification(message.method, message.params);
    }
  }

  /** The server is gone: every waiting request fails instead of hanging. */
  close(reason = "language server stopped"): void {
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
  }

  private answer(id: Id, method: string, params: unknown) {
    const result = this.handlers.onRequest(method, params);
    if (isPromiseLike(result)) {
      result.then(
        (value) => this.write({ jsonrpc: "2.0", id, result: value ?? null }),
        (error: unknown) =>
          this.write({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: String(error) } }),
      );
      return;
    }
    if (result === undefined) {
      this.write({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `Unhandled method ${method}` } });
    } else {
      this.write({ jsonrpc: "2.0", id, result });
    }
  }

  private write(message: Message) {
    this.send(JSON.stringify(message));
  }
}
