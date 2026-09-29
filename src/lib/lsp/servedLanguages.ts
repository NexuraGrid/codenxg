/**
 * Monaco language ids served by an external language server; must match
 * SERVERS in src-tauri/src/commands/lsp.rs. TS/JS/JSON/CSS/HTML are left to
 * Monaco's built-in workers.
 */
export const SERVED_LANGUAGES = ["php", "python", "java", "go", "rust", "c", "cpp", "yaml", "shell", "vue"];
