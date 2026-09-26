/** Languages whose server's semantic tokens are painted over the grammar. */
export const SEMANTIC_LANGUAGES = ["go"];

// The LSP 3.17 defaults. The server's own legend decides what its numbers
// mean; this only tells it which names we understand.
const TOKEN_TYPES = [
  "namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter",
  "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword",
  "modifier", "comment", "string", "number", "regexp", "operator", "decorator",
];
const TOKEN_MODIFIERS = [
  "declaration", "definition", "readonly", "static", "deprecated", "abstract", "async",
  "modification", "documentation", "defaultLibrary",
];

/** Server settings sent with `initialize`. gopls keeps semantic tokens experimental and off by default. */
export const INITIALIZATION_OPTIONS: Record<string, object> = {
  go: { semanticTokens: true },
};

export const SEMANTIC_TOKENS_CAPABILITY = {
  requests: { full: true },
  tokenTypes: TOKEN_TYPES,
  tokenModifiers: TOKEN_MODIFIERS,
  formats: ["relative"],
  overlappingTokenSupport: false,
  multilineTokenSupport: false,
};

export interface SemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export interface SemanticTokensProviderCapability {
  legend?: SemanticTokensLegend;
  full?: boolean | object;
}

/** The server's legend, or null when it can't serve whole-document tokens. */
export function semanticLegend(capability: SemanticTokensProviderCapability | undefined): SemanticTokensLegend | null {
  if (!capability?.legend || !capability.full) return null;
  const { tokenTypes, tokenModifiers } = capability.legend;
  if (!Array.isArray(tokenTypes) || !Array.isArray(tokenModifiers)) return null;
  return { tokenTypes, tokenModifiers };
}

/** LSP's relative encoding (5 integers per token) is what Monaco consumes too. */
export function toSemanticTokenData(result: { data?: number[] } | null | undefined): Uint32Array | null {
  if (!result || !Array.isArray(result.data) || result.data.length % 5 !== 0) return null;
  return new Uint32Array(result.data);
}
