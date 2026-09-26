import { describe, expect, it } from "vitest";
import { parseShellArgs } from "../shellArgs";

describe("parseShellArgs", () => {
  it("splits on whitespace", () => {
    expect(parseShellArgs("-NoLogo -File script.ps1")).toEqual(["-NoLogo", "-File", "script.ps1"]);
  });

  it("collapses repeated whitespace and trims the ends", () => {
    expect(parseShellArgs("  -l   -i  ")).toEqual(["-l", "-i"]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseShellArgs("")).toEqual([]);
    expect(parseShellArgs("   ")).toEqual([]);
  });

  it("returns a single argument unchanged", () => {
    expect(parseShellArgs("-l")).toEqual(["-l"]);
  });
});
