export type AutoSaveMode = "off" | "afterDelay" | "onFocusChange";

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
  wordWrap: boolean;
  minimap: boolean;
  renderWhitespace: boolean;
  formatOnSave: boolean;
}

export interface FilesSettings {
  autoSave: AutoSaveMode;
  autoSaveDelayMs: number;
}

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  /** Empty means auto-detect (see shell.rs): pwsh/powershell/cmd on Windows, $SHELL/bash/sh on Unix. */
  shellPath: string;
  /** Space-separated; parsed with parseShellArgs (src/lib/shellArgs.ts) before being sent to Rust. */
  shellArgs: string;
}

export interface AppSettings {
  editor: EditorSettings;
  files: FilesSettings;
  terminal: TerminalSettings;
}

/** The self-hosted fonts bundled via @fontsource (see main.tsx); free text is also accepted. */
export const BUNDLED_FONTS = ["JetBrains Mono", "IBM Plex Mono"] as const;

// Mirrors the previous hardcoded values in editorOptions.ts / TerminalPanel.tsx,
// so turning the settings feature on doesn't change anyone's editor today.
export const DEFAULT_SETTINGS: AppSettings = {
  editor: {
    fontFamily: "JetBrains Mono",
    fontSize: 15.8,
    lineHeight: 22.5,
    tabSize: 4,
    insertSpaces: true,
    detectIndentation: true,
    wordWrap: false,
    minimap: false,
    renderWhitespace: false,
    formatOnSave: false,
  },
  files: {
    autoSave: "off",
    autoSaveDelayMs: 1000,
  },
  terminal: {
    fontFamily: "IBM Plex Mono",
    fontSize: 13.2,
    shellPath: "",
    shellArgs: "",
  },
};

const AUTO_SAVE_MODES: readonly AutoSaveMode[] = ["off", "afterDelay", "onFocusChange"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number, bounds: { min?: number; max?: number } = {}): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (bounds.min !== undefined && value < bounds.min) return fallback;
  if (bounds.max !== undefined && value > bounds.max) return fallback;
  return value;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function autoSaveMode(value: unknown, fallback: AutoSaveMode): AutoSaveMode {
  return typeof value === "string" && (AUTO_SAVE_MODES as readonly string[]).includes(value)
    ? (value as AutoSaveMode)
    : fallback;
}

function mergeEditor(input: unknown): EditorSettings {
  const defaults = DEFAULT_SETTINGS.editor;
  const source = isRecord(input) ? input : {};
  return {
    fontFamily: str(source.fontFamily, defaults.fontFamily),
    fontSize: num(source.fontSize, defaults.fontSize, { min: 6, max: 96 }),
    lineHeight: num(source.lineHeight, defaults.lineHeight, { min: 6, max: 160 }),
    tabSize: num(source.tabSize, defaults.tabSize, { min: 1, max: 16 }),
    insertSpaces: bool(source.insertSpaces, defaults.insertSpaces),
    detectIndentation: bool(source.detectIndentation, defaults.detectIndentation),
    wordWrap: bool(source.wordWrap, defaults.wordWrap),
    minimap: bool(source.minimap, defaults.minimap),
    renderWhitespace: bool(source.renderWhitespace, defaults.renderWhitespace),
    formatOnSave: bool(source.formatOnSave, defaults.formatOnSave),
  };
}

function mergeFiles(input: unknown): FilesSettings {
  const defaults = DEFAULT_SETTINGS.files;
  const source = isRecord(input) ? input : {};
  return {
    autoSave: autoSaveMode(source.autoSave, defaults.autoSave),
    autoSaveDelayMs: num(source.autoSaveDelayMs, defaults.autoSaveDelayMs, { min: 100, max: 60_000 }),
  };
}

function mergeTerminal(input: unknown): TerminalSettings {
  const defaults = DEFAULT_SETTINGS.terminal;
  const source = isRecord(input) ? input : {};
  return {
    fontFamily: str(source.fontFamily, defaults.fontFamily),
    fontSize: num(source.fontSize, defaults.fontSize, { min: 6, max: 96 }),
    // str()'s fallback for an empty/invalid value is "" here too, which is
    // exactly what "auto-detect" means — no separate empty-is-valid case needed.
    shellPath: str(source.shellPath, defaults.shellPath),
    shellArgs: str(source.shellArgs, defaults.shellArgs),
  };
}

/**
 * Validates and merges arbitrary (possibly stale or hand-edited) JSON against
 * the defaults: unknown top-level keys are dropped, and any field with the
 * wrong type or an out-of-range number falls back to its default — so a
 * corrupt or partially-written settings file never breaks the app.
 */
export function mergeSettings(input: unknown): AppSettings {
  const source = isRecord(input) ? input : {};
  return {
    editor: mergeEditor(source.editor),
    files: mergeFiles(source.files),
    terminal: mergeTerminal(source.terminal),
  };
}
