import { describe, expect, it } from "vitest";
import { checkedItems, emptySelection, selectAll, selectItem, toggleAll, type ListSelection } from "../listSelection";

const items = ["a", "b", "c", "d", "e"];
const checked = (s: ListSelection) => checkedItems(items, s);

describe("listSelection", () => {
  it("toggles single items and moves the anchor", () => {
    let s = selectItem(items, emptySelection, "b", "toggle");
    s = selectItem(items, s, "d", "toggle");
    expect(checked(s)).toEqual(["b", "d"]);
    expect(s.anchor).toBe("d");
    s = selectItem(items, s, "b", "toggle");
    expect(checked(s)).toEqual(["d"]);
    expect(s.anchor).toBe("b");
  });

  it("checks a range from the anchor in either direction, keeping what was checked", () => {
    let s = selectItem(items, emptySelection, "a", "toggle");
    s = selectItem(items, s, "e", "toggle");
    s = selectItem(items, s, "c", "range");
    expect(checked(s)).toEqual(["a", "c", "d", "e"]);
    expect(s.anchor).toBe("e");

    const up = selectItem(items, selectItem(items, emptySelection, "d", "toggle"), "b", "range");
    expect(checked(up)).toEqual(["b", "c", "d"]);
  });

  it("treats a range without an anchor as a toggle", () => {
    const s = selectItem(items, emptySelection, "c", "range");
    expect(checked(s)).toEqual(["c"]);
    expect(s.anchor).toBe("c");
  });

  it("ignores unknown items", () => {
    expect(selectItem(items, emptySelection, "zzz", "toggle")).toBe(emptySelection);
  });

  it("selects all, and toggles between all and nothing", () => {
    const some = selectItem(items, emptySelection, "b", "toggle");
    expect(checked(selectAll(items, some))).toEqual(items);
    const all = toggleAll(items, some);
    expect(checked(all)).toEqual(items);
    expect(checked(toggleAll(items, all))).toEqual([]);
    expect(checked(toggleAll([], emptySelection))).toEqual([]);
  });

  it("drops checked items no longer in the list, in list order", () => {
    const s = { checked: new Set(["e", "gone", "a"]), anchor: null };
    expect(checked(s)).toEqual(["a", "e"]);
  });
});
