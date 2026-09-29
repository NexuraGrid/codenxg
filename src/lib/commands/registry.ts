/**
 * The central command registry behind the Command Palette (Ctrl+Shift+P).
 * Every user-facing action the app offers is declared here once, with the
 * shortcut label the palette shows for it.
 */
export interface Command {
  /** Stable id, VS Code style ("workbench.action.files.save"); also what "recent" remembers. */
  id: string;
  title: string;
  /** Shown before the title: "File: Save". */
  category?: string;
  /** The shortcut as a useHotkey-style combo ("mod+shift+p", "mod+k v" for a chord). */
  keybinding?: string;
  /** Hidden from the palette (and not runnable) while this returns false. */
  when?: () => boolean;
  run: () => void | Promise<void>;
}

const commands = new Map<string, Command>();

/**
 * Registers `command`, replacing any command with the same id. The returned
 * function unregisters it — only if it is still this very registration, so a
 * newer one (a remounted component) is never removed by an older cleanup.
 */
export function registerCommand(command: Command): () => void {
  commands.set(command.id, command);
  return () => {
    if (commands.get(command.id) === command) commands.delete(command.id);
  };
}

export function registerCommands(list: readonly Command[]): () => void {
  const disposers = list.map(registerCommand);
  return () => disposers.forEach((dispose) => dispose());
}

export function unregisterCommand(id: string): void {
  commands.delete(id);
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

/** Whether `command` applies right now; a throwing predicate counts as "no". */
export function isCommandEnabled(command: Command): boolean {
  if (!command.when) return true;
  try {
    return command.when();
  } catch (error) {
    console.error(`Command "${command.id}": when() failed`, error);
    return false;
  }
}

/** Every registered command whose `when` passes, in registration order. */
export function availableCommands(): Command[] {
  return [...commands.values()].filter(isCommandEnabled);
}

/** "Category: Title", or just the title. */
export function commandLabel(command: Pick<Command, "title" | "category">): string {
  return command.category ? `${command.category}: ${command.title}` : command.title;
}

/**
 * Runs a command by id if it is registered and enabled; false otherwise.
 * `recordRecent` (the palette) remembers it as recently used; a shortcut
 * doesn't. Errors are logged, never thrown at the caller.
 */
export async function executeCommand(id: string, { recordRecent = false } = {}): Promise<boolean> {
  const command = commands.get(id);
  if (!command || !isCommandEnabled(command)) return false;
  if (recordRecent) recordRecentCommand(id);
  try {
    await command.run();
  } catch (error) {
    console.error(`Command "${id}" failed`, error);
  }
  return true;
}

// --- Recently used ---------------------------------------------------------

export const RECENT_COMMANDS_KEY = "codenxg.recentCommands";
export const MAX_RECENT_COMMANDS = 20;

/** Most recent first. Storage can be missing or blocked: that just means "none". */
export function recentCommandIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function recordRecentCommand(id: string): void {
  const next = [id, ...recentCommandIds().filter((existing) => existing !== id)].slice(0, MAX_RECENT_COMMANDS);
  try {
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota: recents are a convenience only.
  }
}
