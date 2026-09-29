import { describe, expect, it } from "vitest";
import type { PinGroup } from "../pinGroups";
import {
  backToGroups,
  enterGroup,
  filterGroupFiles,
  filterGroups,
  initialQuickPick,
  matchQuickPickHotkey,
  nthGroupId,
  quickPickKey,
  quickPickShortcutLabel,
  setQuickPickQuery,
  type QuickPickState,
} from "../pinGroupQuickPick";

const groups: PinGroup[] = [
  { id: "a", name: "Auth flow", paths: ["/w/src/auth/login.ts", "/w/src/auth/session.ts"] },
  { id: "b", name: "Billing", paths: ["/w/src/billing/invoice.ts", "/w/README.md"] },
  { id: "c", name: "Checkout", paths: [] },
];

const ids = (state: QuickPickState) =>
  state.groupId === null
    ? filterGroups(groups, state.query).map((g) => g.group.id)
    : filterGroupFiles(groups.find((g) => g.id === state.groupId)!, "/w", state.query).map((f) => f.path);

/** Feeds keys through quickPickKey the way the component does, against the live list. */
function press(state: QuickPickState, ...keys: string[]) {
  let result = { state, command: null as ReturnType<typeof quickPickKey>["command"], handled: false };
  for (const key of keys) result = quickPickKey(result.state, key, ids(result.state));
  return result;
}

describe("pin group quick pick: steps", () => {
  it("starts at the group list, or at a group's files when it exists", () => {
    expect(initialQuickPick(groups).groupId).toBeNull();
    const direct = initialQuickPick(groups, "b");
    expect(direct).toMatchObject({ groupId: "b", query: "", selected: 0, groupSelected: 1 });
    expect(initialQuickPick(groups, "gone").groupId).toBeNull();
  });

  it("Enter on a group opens its files; Enter on a file asks to open it", () => {
    const { state } = press(initialQuickPick(groups), "ArrowDown", "Enter");
    expect(state).toMatchObject({ groupId: "b", query: "", selected: 0 });
    const opened = press(state, "ArrowDown", "Enter");
    expect(opened.command).toEqual({ type: "openFile", groupId: "b", path: "/w/README.md" });
  });

  it("arrows wrap around", () => {
    expect(press(initialQuickPick(groups), "ArrowUp").state.selected).toBe(2);
    expect(press(initialQuickPick(groups), "ArrowDown", "ArrowDown", "ArrowDown").state.selected).toBe(0);
  });

  it("Escape goes back from the files, then closes", () => {
    const inFiles = press(initialQuickPick(groups), "ArrowDown", "Enter").state;
    const back = press(inFiles, "Escape");
    expect(back.command).toBeNull();
    expect(back.state).toMatchObject({ groupId: null, selected: 1 });
    expect(press(back.state, "Escape").command).toEqual({ type: "close" });
  });

  it("Backspace goes back only on an empty filter", () => {
    const inFiles = enterGroup(setQuickPickQuery(initialQuickPick(groups), "bil"), "b");
    const typing = quickPickKey(setQuickPickQuery(inFiles, "inv"), "Backspace", []);
    expect(typing.handled).toBe(false);
    expect(typing.state.groupId).toBe("b");

    const back = quickPickKey(inFiles, "Backspace", []);
    expect(back.handled).toBe(true);
    // Step 1 comes back with the filter it was left with.
    expect(back.state).toMatchObject({ groupId: null, query: "bil", selected: 0 });
    // Backspace at step 1 is just text editing.
    expect(quickPickKey(back.state, "Backspace", []).handled).toBe(false);
  });

  it("going back from a direct (Ctrl+Alt+N) open selects that group", () => {
    const state = backToGroups(initialQuickPick(groups, "c"));
    expect(state).toMatchObject({ groupId: null, query: "", selected: 2 });
  });

  it("Enter with nothing to pick does nothing", () => {
    const empty = enterGroup(initialQuickPick(groups), "c");
    const result = quickPickKey(empty, "Enter", []);
    expect(result).toMatchObject({ handled: true, command: null, state: empty });
  });

  it("typing resets the selection", () => {
    const state = setQuickPickQuery({ ...initialQuickPick(groups), selected: 2 }, "a");
    expect(state).toMatchObject({ query: "a", selected: 0 });
  });

  it("clamps a stale selection after the list shrank", () => {
    const state = { ...initialQuickPick(groups), selected: 5 };
    expect(quickPickKey(state, "Enter", ["a"]).state.groupId).toBe("a");
  });
});

describe("pin group quick pick: filtering", () => {
  it("fuzzy-matches group names, keeping order for an empty query", () => {
    expect(filterGroups(groups, "").map((g) => g.group.id)).toEqual(["a", "b", "c"]);
    const matched = filterGroups(groups, "chk");
    expect(matched.map((g) => g.group.id)).toEqual(["c"]);
    expect(matched[0].indices).toEqual([0, 1, 4]);
    expect(filterGroups(groups, "zzz")).toEqual([]);
  });

  it("matches a group's files by name, then by folder", () => {
    const auth = groups[0];
    expect(filterGroupFiles(auth, "/w", "").map((f) => f.name)).toEqual(["login.ts", "session.ts"]);
    expect(filterGroupFiles(auth, "/w", "sess").map((f) => f.path)).toEqual(["/w/src/auth/session.ts"]);
    expect(filterGroupFiles(auth, "/w", "auth").map((f) => f.path)).toHaveLength(2);
    const [readme] = filterGroupFiles(groups[1], "/w", "read");
    expect(readme).toMatchObject({ name: "README.md", dir: "" });
  });
});

describe("pin group quick pick: shortcuts", () => {
  const key = (code: string, mods: Partial<Parameters<typeof matchQuickPickHotkey>[0]> = {}) =>
    matchQuickPickHotkey({ code, ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, ...mods });

  it("Ctrl/Cmd+Alt+P opens the group list", () => {
    expect(key("KeyP")).toEqual({ nth: null });
    expect(key("KeyP", { ctrlKey: false, metaKey: true })).toEqual({ nth: null });
  });

  it("Ctrl+Alt+1…9 targets the Nth group", () => {
    expect(key("Digit1")).toEqual({ nth: 1 });
    expect(key("Digit9")).toEqual({ nth: 9 });
    expect(key("Digit0")).toBeNull();
    expect(nthGroupId(groups, 2)).toBe("b");
    expect(nthGroupId(groups, 4)).toBeNull();
  });

  it("ignores other modifier combinations and AltGr", () => {
    expect(key("KeyP", { altKey: false })).toBeNull();
    expect(key("KeyP", { ctrlKey: false })).toBeNull();
    expect(key("KeyP", { shiftKey: true })).toBeNull();
    expect(key("Digit2", { altGraph: true })).toBeNull();
  });

  it("labels the shortcut per platform", () => {
    expect(quickPickShortcutLabel(false)).toBe("Ctrl+Alt+P");
    expect(quickPickShortcutLabel(true, "3")).toBe("⌘⌥3");
  });
});
