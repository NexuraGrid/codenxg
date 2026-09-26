import { describe, expect, it } from "vitest";
import * as monaco from "monaco-editor";
import {
  diagnosticsInRange,
  normalizeCodeActionResult,
  providedCodeActionKinds,
  supportsCodeActionResolve,
  supportsPrepareRename,
  toMonacoCodeAction,
} from "../lsp/codeActions";

const range = (l1: number, c1: number, l2: number, c2: number) => ({
  start: { line: l1, character: c1 },
  end: { line: l2, character: c2 },
});

describe("capability checks", () => {
  it("prepareRename requires an object with prepareProvider true", () => {
    expect(supportsPrepareRename(undefined)).toBe(false);
    expect(supportsPrepareRename(true)).toBe(false);
    expect(supportsPrepareRename({})).toBe(false);
    expect(supportsPrepareRename({ prepareProvider: false })).toBe(false);
    expect(supportsPrepareRename({ prepareProvider: true })).toBe(true);
  });

  it("codeAction.resolve requires an object with resolveProvider true", () => {
    expect(supportsCodeActionResolve(undefined)).toBe(false);
    expect(supportsCodeActionResolve(true)).toBe(false);
    expect(supportsCodeActionResolve({ resolveProvider: true })).toBe(true);
  });

  it("reads the advertised code action kinds, if any", () => {
    expect(providedCodeActionKinds(true)).toBeUndefined();
    expect(providedCodeActionKinds({ codeActionKinds: ["quickfix"] })).toEqual(["quickfix"]);
  });
});

describe("diagnosticsInRange", () => {
  const diagnostic = (r: ReturnType<typeof range>, message = "x") => ({ range: r, message });

  it("keeps diagnostics overlapping the range", () => {
    const diagnostics = [diagnostic(range(0, 0, 0, 5)), diagnostic(range(5, 0, 5, 5))];
    expect(diagnosticsInRange(diagnostics, range(0, 2, 0, 3))).toEqual([diagnostics[0]]);
  });

  it("drops diagnostics entirely outside the range", () => {
    const diagnostics = [diagnostic(range(10, 0, 10, 5))];
    expect(diagnosticsInRange(diagnostics, range(0, 0, 1, 0))).toEqual([]);
  });

  it("keeps a diagnostic that only touches the range at its edge", () => {
    const diagnostics = [diagnostic(range(0, 3, 0, 5))];
    expect(diagnosticsInRange(diagnostics, range(0, 0, 0, 3))).toEqual(diagnostics);
  });
});

describe("normalizeCodeActionResult", () => {
  it("wraps a bare Command result as a CodeAction", () => {
    const command = { title: "Add import", command: "php.addImport", arguments: [1] };
    expect(normalizeCodeActionResult(command)).toEqual({ title: "Add import", command });
  });

  it("passes a full CodeAction through unchanged", () => {
    const action = { title: "Add import", kind: "quickfix", edit: { changes: {} } };
    expect(normalizeCodeActionResult(action)).toBe(action);
  });
});

describe("toMonacoCodeAction", () => {
  it("never exposes edit/command directly, routing both through one synthetic command", () => {
    const action = {
      title: "Add import",
      kind: "quickfix",
      isPreferred: true,
      edit: { changes: { "file:///a.php": [{ range: range(0, 0, 0, 1), newText: "x" }] } },
    };
    const mapped = toMonacoCodeAction(action, "codenxg.codeAction.apply");
    expect(mapped).not.toHaveProperty("edit");
    expect(mapped.title).toBe("Add import");
    expect(mapped.kind).toBe("quickfix");
    expect(mapped.isPreferred).toBe(true);
    expect(mapped.command).toEqual({ id: "codenxg.codeAction.apply", title: "Add import", arguments: [action] });
  });

  it("maps disabled reason and diagnostics", () => {
    const action = {
      title: "Fix it",
      disabled: { reason: "no fix available" },
      diagnostics: [{ range: range(0, 0, 0, 1), message: "bad", severity: 1 }],
    };
    const mapped = toMonacoCodeAction(action, "cmd");
    expect(mapped.disabled).toBe("no fix available");
    expect(mapped.diagnostics?.[0].message).toBe("bad");
    expect(mapped.diagnostics?.[0].severity).toBe(monaco.MarkerSeverity.Error);
  });
});
