import { describe, expect, it } from "vitest";
import { semanticLegend, toSemanticTokenData } from "../lsp/semanticTokens";

describe("semanticLegend", () => {
  it("returns the legend of a server that serves full documents", () => {
    const legend = { tokenTypes: ["type"], tokenModifiers: ["readonly"] };
    expect(semanticLegend({ legend, full: true })).toEqual(legend);
    expect(semanticLegend({ legend, full: { delta: true } })).toEqual(legend);
  });

  it("returns null when the server has no usable support", () => {
    expect(semanticLegend(undefined)).toBeNull();
    expect(semanticLegend({ legend: { tokenTypes: [], tokenModifiers: [] } })).toBeNull();
    expect(semanticLegend({ full: true })).toBeNull();
  });
});

describe("toSemanticTokenData", () => {
  it("converts the integer stream", () => {
    const data = toSemanticTokenData({ data: [0, 0, 3, 12, 1, 1, 4, 2, 8, 0] });
    expect(Array.from(data ?? [])).toEqual([0, 0, 3, 12, 1, 1, 4, 2, 8, 0]);
  });

  it("rejects an empty result or a stream that is not whole tokens", () => {
    expect(toSemanticTokenData(null)).toBeNull();
    expect(toSemanticTokenData({})).toBeNull();
    expect(toSemanticTokenData({ data: [1, 2, 3] })).toBeNull();
  });
});
