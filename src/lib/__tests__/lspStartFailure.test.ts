import { describe, expect, it } from "vitest";
import { parseStartFailure, parseToolMissing } from "../lsp/startFailure";

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

describe("parseToolMissing", () => {
  it("splits the tool from what to install, keeping colons in the description", () => {
    expect(parseToolMissing("tool-missing:npm:Node.js with npm (https://nodejs.org)")).toEqual({
      tool: "npm",
      requires: "Node.js with npm (https://nodejs.org)",
    });
  });

  it("keeps a found-version note", () => {
    expect(parseToolMissing("tool-missing:java:Java 25 or newer (https://adoptium.net); found Java 21")?.requires).toBe(
      "Java 25 or newer (https://adoptium.net); found Java 21",
    );
  });

  it("ignores other errors", () => {
    expect(parseToolMissing("not-installed:installable:npm install -g pyright")).toBeNull();
    expect(parseToolMissing("npm install -g pyright failed (exit status: 1)")).toBeNull();
  });
});
