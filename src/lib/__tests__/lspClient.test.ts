import { describe, expect, it } from "vitest";
import { LspClient } from "../lsp/client";

function setup(onRequest: (method: string, params: unknown) => unknown = () => undefined) {
  const sent: any[] = [];
  const notifications: [string, unknown][] = [];
  const client = new LspClient((json) => sent.push(JSON.parse(json)), {
    onNotification: (method, params) => notifications.push([method, params]),
    onRequest,
  });
  return { client, sent, notifications };
}

function fakeToken() {
  let listener: (() => void) | undefined;
  return {
    token: {
      isCancellationRequested: false,
      onCancellationRequested: (l: () => void) => ((listener = l), { dispose: () => (listener = undefined) }),
    },
    cancel: () => listener?.(),
  };
}

describe("LspClient", () => {
  it("matches responses to requests by id", async () => {
    const { client, sent } = setup();
    const first = client.request("a", {});
    const second = client.request("b", {});
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: sent[1].id, result: "B" }));
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: sent[0].id, result: "A" }));
    await expect(first).resolves.toBe("A");
    await expect(second).resolves.toBe("B");
  });

  it("rejects on an error response", async () => {
    const { client, sent } = setup();
    const pending = client.request("x", {});
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: sent[0].id, error: { code: 1, message: "boom" } }));
    await expect(pending).rejects.toThrow("boom");
  });

  it("answers server requests, and reports unknown ones as unsupported", () => {
    const { client, sent } = setup((method) => (method === "workspace/configuration" ? [null] : undefined));
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "workspace/configuration", params: {} }));
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "weird/thing" }));
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 7, result: [null] });
    expect(sent[1].error.code).toBe(-32601);
  });

  it("forwards notifications", () => {
    const { client, notifications } = setup();
    client.receive(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "u" } }));
    expect(notifications).toEqual([["textDocument/publishDiagnostics", { uri: "u" }]]);
  });

  it("tells the server when a request is cancelled", async () => {
    const { client, sent } = setup();
    const { token, cancel } = fakeToken();
    const pending = client.request("slow", {}, token);
    cancel();
    await expect(pending).rejects.toThrow("cancelled");
    expect(sent[1]).toEqual({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: sent[0].id } });
  });

  it("sends a proper JSON-RPC response for an async onRequest result", async () => {
    const { client, sent } = setup(() => Promise.resolve({ applied: true }));
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "workspace/applyEdit", params: {} }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 1, result: { applied: true } }]);
  });

  it("sends a JSON-RPC error when an async onRequest handler rejects", async () => {
    const { client, sent } = setup(() => Promise.reject(new Error("boom")));
    client.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "workspace/applyEdit", params: {} }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0].error.message).toBe("Error: boom");
  });

  it("fails waiting requests when the server stops", async () => {
    const { client } = setup();
    const pending = client.request("x", {});
    client.close();
    await expect(pending).rejects.toThrow("stopped");
    await expect(client.request("y", {})).rejects.toThrow("stopped");
  });
});
