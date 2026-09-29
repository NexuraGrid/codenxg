/** What lsp_start's `not-installed:` error says about a missing server. */
export interface MissingServer {
  /** Full hint, possibly with extra notes after three spaces. */
  hint: string;
  /** Just the command part of the hint, for the clipboard. */
  command: string;
  /** lsp_install can install it with one click. */
  installable: boolean;
}

/** Null for any other start failure (crash, bad config, …). */
export function parseStartFailure(error: string): MissingServer | null {
  const rest = error.match(/not-installed:(.*)$/)?.[1];
  if (rest === undefined) return null;
  const installable = rest.startsWith("installable:");
  const hint = installable ? rest.slice("installable:".length) : rest;
  return { hint, command: hint.split("   ")[0], installable };
}

/** A tool the server's install (or the server itself) needs but isn't there. */
export interface MissingTool {
  /** The program looked for: npm, go, rustup, java. */
  tool: string;
  /** What to install and where to get it, e.g. "Node.js with npm (https://nodejs.org)". */
  requires: string;
}

/** Parses lsp_install's / lsp_start's `tool-missing:<tool>:<requires>`; null otherwise. */
export function parseToolMissing(error: string): MissingTool | null {
  const match = error.match(/tool-missing:([^:]+):(.*)$/s);
  if (!match) return null;
  return { tool: match[1], requires: match[2] };
}
