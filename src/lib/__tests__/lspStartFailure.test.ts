import { describe, expect, it } from "vitest";
import { parseStartFailure } from "../lsp/startFailure";

describe("parseStartFailure", () => {
  it("recognizes a one-click installable server", () => {
    expect(parseStartFailure("not-installed:installable:npm install -g intelephense")).toEqual({
      hint: "npm install -g intelephense",
      command: "npm install -g intelephense",
      installable: true,
    });
  });

  it("keeps manual hints and strips their notes from the command", () => {
    expect(parseStartFailure("not-installed:brew install jdtls   (needs Java 21+)")).toEqual({
      hint: "brew install jdtls   (needs Java 21+)",
      command: "brew install jdtls",
      installable: false,
    });
  });

  it("ignores other start failures", () => {
    expect(parseStartFailure("Couldn't start gopls: permission denied")).toBeNull();
  });
});
