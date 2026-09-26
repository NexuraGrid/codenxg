import { describe, expect, it } from "vitest";
import * as monaco from "monaco-editor";
import { pathFromUri } from "../paths";

// Builds a Uri the way a *Windows* browser would (monaco.Uri.file() only
// lower-cases/forward-slashes on the platform it actually runs on, which in
// this Linux test run it doesn't) — bypass that with Uri.from so the exact
// shape a real Windows webview or a language server would send is tested.
function windowsStyleUri(path: string): monaco.Uri {
  return monaco.Uri.from({ scheme: "file", authority: "", path, query: "", fragment: "" });
}

describe("pathFromUri", () => {
  it("leaves a POSIX path unchanged", () => {
    const uri = monaco.Uri.file("/home/andres/project/src/index.ts");
    expect(pathFromUri(uri)).toBe("/home/andres/project/src/index.ts");
  });

  it("converts a lower-cased-drive Windows URI path back to the app's backslash form", () => {
    const uri = windowsStyleUri("/c:/Users/andres/project/src/index.ts");
    expect(pathFromUri(uri)).toBe("C:\\Users\\andres\\project\\src\\index.ts");
  });

  it("upper-cases an already upper-cased drive letter (idempotent)", () => {
    const uri = windowsStyleUri("/C:/Users/andres/project/src/index.ts");
    expect(pathFromUri(uri)).toBe("C:\\Users\\andres\\project\\src\\index.ts");
  });

  it("handles a bare drive root", () => {
    expect(pathFromUri(windowsStyleUri("/c:/"))).toBe("C:\\");
  });

  it("passes through a plain object with just a path field", () => {
    expect(pathFromUri({ path: "/c:/a/b.ts" })).toBe("C:\\a\\b.ts");
  });
});
