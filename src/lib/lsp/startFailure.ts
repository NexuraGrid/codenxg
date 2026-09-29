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
