import { fuzzyMatch } from "../fuzzy";
import { commandLabel, type Command } from "./registry";

export interface CommandResult {
  command: Command;
  label: string;
  /** Matched character indices in `label`, for highlighting. */
  indices: number[];
}

/** A small nudge so, among similar matches, what was used recently wins. */
const RECENT_BONUS = 3;

/**
 * The palette's list for `query`, fuzzy-matched against "Category: Title".
 * Empty query: recently used commands first (most recent first), then the
 * rest alphabetically. Otherwise best match first; recency breaks near-ties.
 */
export function filterCommands(commands: readonly Command[], query: string, recentIds: readonly string[] = []): CommandResult[] {
  const recentRank = new Map(recentIds.map((id, i) => [id, i]));
  const rank = (command: Command) => recentRank.get(command.id) ?? Infinity;
  const q = query.replace(/\s+/g, "");

  if (!q) {
    return commands
      .map((command) => ({ command, label: commandLabel(command), indices: [] }))
      .sort((a, b) => rank(a.command) - rank(b.command) || a.label.localeCompare(b.label));
  }

  const scored: (CommandResult & { score: number })[] = [];
  for (const command of commands) {
    const label = commandLabel(command);
    const match = fuzzyMatch(q, label);
    if (!match) continue;
    const bonus = recentRank.has(command.id) ? RECENT_BONUS : 0;
    scored.push({ command, label, indices: match.indices, score: match.score + bonus });
  }
  scored.sort(
    (a, b) => b.score - a.score || rank(a.command) - rank(b.command) || a.label.localeCompare(b.label),
  );
  return scored.map(({ command, label, indices }) => ({ command, label, indices }));
}
