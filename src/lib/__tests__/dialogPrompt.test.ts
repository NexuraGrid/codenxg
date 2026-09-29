import { describe, expect, it } from "vitest";
import { promptText, useDialogStore } from "../../state/dialogStore";

describe("promptText", () => {
  it("starts from the initial value and resolves to the trimmed text on OK", async () => {
    const answer = promptText({ title: "Name", initialValue: "old" });
    expect(useDialogStore.getState().inputValue).toBe("old");
    useDialogStore.getState().setInputValue("  new name ");
    useDialogStore.getState().close("ok");
    await expect(answer).resolves.toBe("new name");
  });

  it("resolves to null when cancelled", async () => {
    const answer = promptText({ title: "Name" });
    useDialogStore.getState().setInputValue("typed");
    useDialogStore.getState().close("cancel");
    await expect(answer).resolves.toBeNull();
  });
});
