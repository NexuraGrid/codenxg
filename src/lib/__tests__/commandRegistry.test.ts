import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RECENT_COMMANDS,
  RECENT_COMMANDS_KEY,
  availableCommands,
  commandLabel,
  executeCommand,
  getCommand,
  recentCommandIds,
  recordRecentCommand,
  registerCommand,
  registerCommands,
  unregisterCommand,
  type Command,
} from "../commands/registry";
import { filterCommands } from "../commands/filter";
import { formatKeybinding } from "../commands/keybindingLabel";

const noop = () => {};
const cleanups: (() => void)[] = [];

function register(command: Command) {
  cleanups.push(registerCommand(command));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

describe("command registry", () => {
  it("registers and unregisters commands", () => {
    const dispose = registerCommand({ id: "t.a", title: "A", run: noop });
    expect(getCommand("t.a")?.title).toBe("A");
    dispose();
    expect(getCommand("t.a")).toBeUndefined();

    register({ id: "t.b", title: "B", run: noop });
    unregisterCommand("t.b");
    expect(getCommand("t.b")).toBeUndefined();
  });

  it("an old disposer never removes a newer registration of the same id", () => {
    const disposeOld = registerCommand({ id: "t.same", title: "Old", run: noop });
    register({ id: "t.same", title: "New", run: noop });
    disposeOld();
    expect(getCommand("t.same")?.title).toBe("New");
  });

  it("registerCommands disposes all of them at once", () => {
    const dispose = registerCommands([
      { id: "t.x", title: "X", run: noop },
      { id: "t.y", title: "Y", run: noop },
    ]);
    expect(getCommand("t.x")).toBeDefined();
    dispose();
    expect(getCommand("t.x")).toBeUndefined();
    expect(getCommand("t.y")).toBeUndefined();
  });

  it("filters out commands whose when() is false or throws", () => {
    vi.spyOn(console, "error").mockImplementation(noop);
    register({ id: "t.on", title: "On", when: () => true, run: noop });
    register({ id: "t.off", title: "Off", when: () => false, run: noop });
    register({ id: "t.bad", title: "Bad", when: () => { throw new Error("boom"); }, run: noop });
    const ids = availableCommands().map((c) => c.id);
    expect(ids).toContain("t.on");
    expect(ids).not.toContain("t.off");
    expect(ids).not.toContain("t.bad");
  });

  it("executes only enabled commands, recording recents on request", async () => {
    const run = vi.fn();
    register({ id: "t.run", title: "Run", run });
    register({ id: "t.disabled", title: "Disabled", when: () => false, run });

    expect(await executeCommand("t.disabled", { recordRecent: true })).toBe(false);
    expect(await executeCommand("t.missing")).toBe(false);
    expect(run).not.toHaveBeenCalled();

    expect(await executeCommand("t.run")).toBe(true);
    expect(recentCommandIds()).toEqual([]);
    expect(await executeCommand("t.run", { recordRecent: true })).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(recentCommandIds()).toEqual(["t.run"]);
  });

  it("a failing command is logged, not thrown", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(noop);
    register({ id: "t.fail", title: "Fail", run: () => Promise.reject(new Error("nope")) });
    await expect(executeCommand("t.fail")).resolves.toBe(true);
    expect(error).toHaveBeenCalled();
  });

  it("labels as Category: Title", () => {
    expect(commandLabel({ title: "Save", category: "File" })).toBe("File: Save");
    expect(commandLabel({ title: "Go to File…" })).toBe("Go to File…");
  });
});

describe("recently used commands", () => {
  it("keeps the most recent first, without duplicates, capped", () => {
    recordRecentCommand("a");
    recordRecentCommand("b");
    recordRecentCommand("a");
    expect(recentCommandIds()).toEqual(["a", "b"]);

    for (let i = 0; i < MAX_RECENT_COMMANDS + 5; i++) recordRecentCommand(`c${i}`);
    expect(recentCommandIds()).toHaveLength(MAX_RECENT_COMMANDS);
    expect(recentCommandIds()[0]).toBe(`c${MAX_RECENT_COMMANDS + 4}`);
  });

  it("ignores corrupt storage", () => {
    localStorage.setItem(RECENT_COMMANDS_KEY, "{not json");
    expect(recentCommandIds()).toEqual([]);
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(["ok", 3, null]));
    expect(recentCommandIds()).toEqual(["ok"]);
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(recentCommandIds()).toEqual([]);
    expect(() => recordRecentCommand("x")).not.toThrow();
  });
});

describe("filterCommands", () => {
  const commands: Command[] = [
    { id: "save", title: "Save", category: "File", run: noop },
    { id: "settings", title: "Open Settings", category: "Preferences", run: noop },
    { id: "push", title: "Push", category: "Git", run: noop },
    { id: "pull", title: "Pull", category: "Git", run: noop },
    { id: "format", title: "Format Document", category: "Editor", run: noop },
  ];

  it("empty query: recent first (most recent first), then alphabetical", () => {
    const labels = filterCommands(commands, "", ["push", "format"]).map((r) => r.label);
    expect(labels).toEqual([
      "Git: Push",
      "Editor: Format Document",
      "File: Save",
      "Git: Pull",
      "Preferences: Open Settings",
    ]);
  });

  it("fuzzy matches on Category: Title and returns highlight indices", () => {
    const results = filterCommands(commands, "gitpu");
    expect(results.map((r) => r.command.id).sort()).toEqual(["pull", "push"]);
    const push = results.find((r) => r.command.id === "push")!;
    expect(push.indices.map((i) => push.label[i]).join("").toLowerCase()).toBe("gitpu");
  });

  it("ignores spaces in the query and drops non-matches", () => {
    expect(filterCommands(commands, "format doc").map((r) => r.command.id)).toEqual(["format"]);
    expect(filterCommands(commands, "zzz")).toEqual([]);
  });

  it("ranks word-start matches above scattered ones", () => {
    expect(filterCommands(commands, "save")[0].command.id).toBe("save");
  });

  it("recency breaks ties between equally good matches", () => {
    expect(filterCommands(commands, "gitp", []).map((r) => r.command.id)).toEqual(["pull", "push"]);
    expect(filterCommands(commands, "gitp", ["push"]).map((r) => r.command.id)).toEqual(["push", "pull"]);
  });
});

describe("formatKeybinding", () => {
  it("formats for Windows/Linux", () => {
    expect(formatKeybinding("mod+shift+p", false)).toBe("Ctrl+Shift+P");
    expect(formatKeybinding("mod+k v", false)).toBe("Ctrl+K V");
    expect(formatKeybinding("f1", false)).toBe("F1");
    expect(formatKeybinding("mod+alt+3", false)).toBe("Ctrl+Alt+3");
  });

  it("formats for macOS", () => {
    expect(formatKeybinding("mod+shift+p", true)).toBe("⌘⇧P");
    expect(formatKeybinding("mod+,", true)).toBe("⌘,");
    expect(formatKeybinding("shift+alt+f", true)).toBe("⇧⌥F");
  });
});

describe("app commands", () => {
  it("declare unique ids", async () => {
    const { appCommands, layoutCommands } = await import("../commands/appCommands");
    const all = [...appCommands(), ...layoutCommands(() => { throw new Error("not called"); })];
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    // The first import pulls in Monaco, which takes >5s under a full parallel run.
  }, 30_000);
});
