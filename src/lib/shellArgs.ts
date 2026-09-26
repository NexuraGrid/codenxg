/**
 * Turns the "Shell args" settings field (a plain string, like a shell
 * command line) into the argv array `createTerminal` sends to Rust.
 *
 * Deliberately just a whitespace split — no quoting/escaping support. An arg
 * that needs a literal space (a path with one, say) isn't representable
 * here; that's an acceptable limit for a "shell args" convenience field.
 */
export function parseShellArgs(input: string): string[] {
  const trimmed = input.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}
