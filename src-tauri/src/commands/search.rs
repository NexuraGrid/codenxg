use super::fs::{workspace_walk_builder, write_atomic, MAX_OPEN_BYTES};
use super::workspace::ensure_in_workspace;
use crate::state::WorkspaceState;
use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

// Same cap quick open uses for a single result set; a project-wide search
// with more hits than this is one nobody scrolls through anyway.
const MAX_MATCHES: usize = 5000;
// Characters of context kept on each side of a match in the line preview, so
// a 10,000-character minified line doesn't get shipped to the frontend whole.
const PREVIEW_CONTEXT: usize = 60;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub query: String,
    pub match_case: bool,
    pub whole_word: bool,
    pub use_regex: bool,
    /// Comma-separated glob(s); empty/absent means "no filter".
    pub include: Option<String>,
    pub exclude: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: u32,
    pub start_column: u32,
    pub end_column: u32,
    pub match_text: String,
    pub preview: String,
    pub preview_match_start: u32,
    pub preview_match_end: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub files: Vec<FileMatches>,
    pub match_count: usize,
    pub truncated: bool,
}

/// Builds the regex the query maps to: literal text is escaped unless
/// `use_regex` is set, and `whole_word` wraps it in word boundaries.
fn build_regex(query: &SearchQuery) -> Result<Regex, String> {
    if query.query.is_empty() {
        return Err("Type something to search for".into());
    }
    let mut pattern = if query.use_regex {
        query.query.clone()
    } else {
        regex::escape(&query.query)
    };
    if query.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    RegexBuilder::new(&pattern)
        .case_insensitive(!query.match_case)
        .build()
        .map_err(|e| e.to_string())
}

/// Parses a comma-separated list of simple globs (`*`, `?`, `**`) into a set
/// that can be tested against a path relative to the workspace root. `None`
/// for an empty/absent pattern, which callers treat as "no filter".
fn build_globset(patterns: &str) -> Result<Option<GlobSet>, String> {
    let mut builder = GlobSetBuilder::new();
    let mut any = false;
    for part in patterns.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        any = true;
        builder.add(Glob::new(part).map_err(|e| e.to_string())?);
    }
    if !any {
        return Ok(None);
    }
    builder.build().map(Some).map_err(|e| e.to_string())
}

/// A crude but cheap binary check, same idea as `git`'s: a NUL byte in the
/// first few KB means "don't try to decode this as text".
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

/// Trims a long line to `PREVIEW_CONTEXT` characters on each side of the
/// match, returning the preview text plus the match's offsets within it.
fn make_preview(line: &str, match_start: usize, match_end: usize) -> (String, usize, usize) {
    let chars: Vec<char> = line.chars().collect();
    let from = match_start.saturating_sub(PREVIEW_CONTEXT);
    let to = (match_end + PREVIEW_CONTEXT).min(chars.len());

    let prefix = if from > 0 { "…" } else { "" };
    let suffix = if to < chars.len() { "…" } else { "" };
    let body: String = chars[from..to].iter().collect();

    let preview = format!("{prefix}{body}{suffix}");
    // Offsets are UTF-16 units: the frontend slices the preview as a JS string.
    let utf16 = |cs: &[char]| cs.iter().map(|c| c.len_utf16()).sum::<usize>();
    let offset = prefix.encode_utf16().count();
    let start = offset + utf16(&chars[from..match_start]);
    let end = start + utf16(&chars[match_start..match_end]);
    (preview, start, end)
}

/// Path relative to the workspace root, for glob matching only — results are
/// keyed by the full path, like every other command in this app (quick
/// open, git status), so the frontend never has to reconstruct one.
fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

/// Every match for `regex` in one file's text, capped by `remaining`.
fn matches_in_text(regex: &Regex, text: &str, remaining: usize) -> Vec<SearchMatch> {
    let mut out = Vec::new();
    for (line_index, line) in text.lines().enumerate() {
        if out.len() >= remaining {
            break;
        }
        // Byte offsets from the regex are re-mapped to char counts for the
        // preview, and to UTF-16 units for columns so they line up with
        // Monaco (and JS string indexing) even past astral chars like emoji.
        let char_starts: Vec<usize> = line.char_indices().map(|(i, _)| i).collect();
        let byte_to_char = |byte: usize| char_starts.partition_point(|&i| i < byte);

        for found in regex.find_iter(line) {
            if out.len() >= remaining {
                break;
            }
            let start_char = byte_to_char(found.start());
            let end_char = byte_to_char(found.end());
            let (preview, preview_start, preview_end) = make_preview(line, start_char, end_char);

            out.push(SearchMatch {
                line: (line_index + 1) as u32,
                start_column: (line[..found.start()].encode_utf16().count() + 1) as u32,
                end_column: (line[..found.end()].encode_utf16().count() + 1) as u32,
                match_text: found.as_str().to_string(),
                preview,
                preview_match_start: preview_start as u32,
                preview_match_end: preview_end as u32,
            });
        }
    }
    out
}

/// Project-wide search: walks the workspace like quick open (honouring
/// `.gitignore`, skipping the same heavy folders), then scans each candidate
/// file's text for `query`. Async: file reads under `/mnt/c` cross WSL's 9P
/// bridge and a search over a large tree would otherwise freeze the window.
#[tauri::command(async)]
pub fn search_in_workspace(
    state: State<'_, WorkspaceState>,
    root: String,
    query: SearchQuery,
) -> Result<SearchResponse, String> {
    let root = ensure_in_workspace(&state, &root)?;
    let regex = build_regex(&query)?;
    let include = build_globset(query.include.as_deref().unwrap_or(""))?;
    let exclude = build_globset(query.exclude.as_deref().unwrap_or(""))?;

    Ok(walk_and_search(&root, &regex, include.as_ref(), exclude.as_ref()))
}

// Holds both the accumulated files and the running match count behind one
// lock, so the 5000-match cap is exact even with several files finishing a
// scan at the same instant (each only trims/accounts for itself while
// holding the lock; the actual file read and regex scan happen outside it).
struct Accumulator {
    files: Vec<FileMatches>,
    match_count: usize,
    truncated: bool,
}

fn walk_and_search(root: &Path, regex: &Regex, include: Option<&GlobSet>, exclude: Option<&GlobSet>) -> SearchResponse {
    use ignore::WalkState;

    let state = Mutex::new(Accumulator { files: Vec::new(), match_count: 0, truncated: false });

    workspace_walk_builder(root).build_parallel().run(|| {
        Box::new(|entry| {
            if state.lock().unwrap().match_count >= MAX_MATCHES {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            let path = entry.path();
            let relative = relative_path(root, path);

            if include.is_some_and(|g| !g.is_match(&relative)) {
                return WalkState::Continue;
            }
            if exclude.is_some_and(|g| g.is_match(&relative)) {
                return WalkState::Continue;
            }

            let Ok(metadata) = entry.metadata() else { return WalkState::Continue };
            if metadata.len() > MAX_OPEN_BYTES {
                return WalkState::Continue;
            }

            let Ok(bytes) = std::fs::read(path) else { return WalkState::Continue };
            if looks_binary(&bytes) {
                return WalkState::Continue;
            }
            let Ok(text) = String::from_utf8(bytes) else { return WalkState::Continue };

            // Scanned with a generous per-file cap; the exact cross-file cap
            // is enforced below, under the lock.
            let mut file_matches = matches_in_text(regex, &text, MAX_MATCHES);
            if file_matches.is_empty() {
                return WalkState::Continue;
            }

            let mut guard = state.lock().unwrap();
            let remaining = MAX_MATCHES.saturating_sub(guard.match_count);
            if remaining == 0 {
                guard.truncated = true;
                return WalkState::Quit;
            }
            if file_matches.len() > remaining {
                file_matches.truncate(remaining);
                guard.truncated = true;
            }
            guard.match_count += file_matches.len();
            guard.files.push(FileMatches { path: path.to_string_lossy().to_string(), matches: file_matches });
            WalkState::Continue
        })
    });

    let mut result = state.into_inner().unwrap();
    result.files.sort_by(|a, b| a.path.cmp(&b.path));
    SearchResponse { match_count: result.match_count, truncated: result.truncated, files: result.files }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWrite {
    pub path: String,
    pub content: String,
}

/// Writes several files at once (project-wide "replace all"), atomically per
/// file via the same temp+rename `write_file` uses. Best-effort: a failing
/// file doesn't stop the rest, and every failure is reported together.
#[tauri::command(async)]
pub fn write_search_files(state: State<'_, WorkspaceState>, files: Vec<FileWrite>) -> Result<(), String> {
    let mut errors = Vec::new();
    for file in files {
        match ensure_in_workspace(&state, &file.path) {
            Ok(path) => {
                if let Err(e) = write_atomic(&path, file.content.as_bytes()) {
                    errors.push(format!("{}: {e}", file.path));
                }
            }
            Err(e) => errors.push(format!("{}: {e}", file.path)),
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::{build_globset, build_regex, looks_binary, make_preview, matches_in_text, walk_and_search, SearchQuery};
    use std::path::PathBuf;

    fn query(text: &str) -> SearchQuery {
        SearchQuery {
            query: text.to_string(),
            match_case: false,
            whole_word: false,
            use_regex: false,
            include: None,
            exclude: None,
        }
    }

    #[test]
    fn matches_ignore_case_by_default() {
        let regex = build_regex(&query("foo")).unwrap();
        assert!(regex.is_match("FOO"));
    }

    #[test]
    fn match_case_is_respected() {
        let mut q = query("foo");
        q.match_case = true;
        let regex = build_regex(&q).unwrap();
        assert!(!regex.is_match("FOO"));
        assert!(regex.is_match("foo"));
    }

    #[test]
    fn whole_word_does_not_match_inside_a_longer_word() {
        let mut q = query("cat");
        q.whole_word = true;
        let regex = build_regex(&q).unwrap();
        assert!(!regex.is_match("concatenate"));
        assert!(regex.is_match("a cat sat"));
    }

    #[test]
    fn literal_query_escapes_regex_metacharacters() {
        let regex = build_regex(&query("a.b(")).unwrap();
        assert!(!regex.is_match("axb("));
        assert!(regex.is_match("a.b("));
    }

    #[test]
    fn regex_mode_uses_the_pattern_directly() {
        let mut q = query(r"f\w+");
        q.use_regex = true;
        let regex = build_regex(&q).unwrap();
        assert!(regex.is_match("foobar"));
    }

    #[test]
    fn invalid_regex_is_rejected_with_a_message() {
        let mut q = query("(unterminated");
        q.use_regex = true;
        assert!(build_regex(&q).is_err());
    }

    #[test]
    fn columns_are_utf16_units_past_astral_chars() {
        let regex = build_regex(&query("foo")).unwrap();
        let found = matches_in_text(&regex, "😀 foo", 10);
        assert_eq!(found[0].start_column, 4);
        assert_eq!(found[0].end_column, 7);
        assert_eq!(&found[0].preview, "😀 foo");
        assert_eq!(found[0].preview_match_start, 3);
        assert_eq!(found[0].preview_match_end, 6);
    }

    #[test]
    fn matches_in_text_reports_line_and_column() {
        let regex = build_regex(&query("foo")).unwrap();
        let found = matches_in_text(&regex, "one\ntwo foo three\n", 100);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 2);
        assert_eq!(found[0].start_column, 5);
        assert_eq!(found[0].end_column, 8);
        assert_eq!(found[0].match_text, "foo");
    }

    #[test]
    fn matches_in_text_respects_the_remaining_cap() {
        let regex = build_regex(&query("x")).unwrap();
        let found = matches_in_text(&regex, "x x x x x", 2);
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn preview_is_untouched_for_a_short_line() {
        let (preview, start, end) = make_preview("const foo = 1;", 6, 9);
        assert_eq!(preview, "const foo = 1;");
        assert_eq!((start, end), (6, 9));
    }

    #[test]
    fn preview_trims_a_long_line_around_the_match() {
        let padding = "x".repeat(200);
        let line = format!("{padding}NEEDLE{padding}");
        let match_start = 200;
        let match_end = 206;
        let (preview, start, end) = make_preview(&line, match_start, match_end);

        assert!(preview.starts_with('…'));
        assert!(preview.ends_with('…'));
        assert!(preview.len() < line.len());
        let chars: Vec<char> = preview.chars().collect();
        let matched: String = chars[start..end].iter().collect();
        assert_eq!(matched, "NEEDLE");
    }

    #[test]
    fn binary_content_is_detected_by_a_nul_byte() {
        assert!(looks_binary(b"abc\0def"));
        assert!(!looks_binary(b"plain text"));
    }

    #[test]
    fn globset_matches_simple_patterns() {
        let set = build_globset("*.ts,src/**/*.rs").unwrap().unwrap();
        assert!(set.is_match("index.ts"));
        assert!(set.is_match("src/lib/mod.rs"));
        assert!(!set.is_match("index.js"));
    }

    // `*` isn't confined to one path segment here (globset's default), so a
    // plain extension pattern like "*.ts" behaves the way users expect: it
    // matches a .ts file at any depth, not just at the workspace root.
    #[test]
    fn a_bare_extension_pattern_matches_at_any_depth() {
        let set = build_globset("*.ts").unwrap().unwrap();
        assert!(set.is_match("index.ts"));
        assert!(set.is_match("src/deep/nested/index.ts"));
    }

    #[test]
    fn empty_glob_pattern_means_no_filter() {
        assert!(build_globset("").unwrap().is_none());
        assert!(build_globset("   ").unwrap().is_none());
    }

    fn scratch_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("code-editor-search-{label}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn walk_and_search_finds_matches_across_files_and_skips_gitignored_ones() {
        let dir = scratch_dir("walk");
        std::fs::write(dir.join(".gitignore"), "skip.txt\n").unwrap();
        std::fs::write(dir.join("a.txt"), "hello world").unwrap();
        std::fs::write(dir.join("skip.txt"), "hello ignored").unwrap();
        std::fs::create_dir(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join("b.txt"), "hello again").unwrap();

        let regex = build_regex(&query("hello")).unwrap();
        let result = walk_and_search(&dir, &regex, None, None);

        let paths: Vec<String> = result.files.iter().map(|f| f.path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                dir.join("a.txt").to_string_lossy().to_string(),
                dir.join("src").join("b.txt").to_string_lossy().to_string(),
            ]
        );
        assert_eq!(result.match_count, 2);
        assert!(!result.truncated);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn walk_and_search_honours_include_and_exclude_globs() {
        let dir = scratch_dir("globs");
        std::fs::write(dir.join("a.ts"), "hello").unwrap();
        std::fs::write(dir.join("a.js"), "hello").unwrap();

        let regex = build_regex(&query("hello")).unwrap();
        let include = build_globset("*.ts").unwrap();
        let result = walk_and_search(&dir, &regex, include.as_ref(), None);

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, dir.join("a.ts").to_string_lossy());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn walk_and_search_skips_binary_files() {
        let dir = scratch_dir("binary");
        std::fs::write(dir.join("bin.dat"), b"hello\0world").unwrap();
        std::fs::write(dir.join("text.txt"), "hello world").unwrap();

        let regex = build_regex(&query("hello")).unwrap();
        let result = walk_and_search(&dir, &regex, None, None);

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, dir.join("text.txt").to_string_lossy());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn walk_and_search_caps_total_matches_and_reports_truncated() {
        let dir = scratch_dir("cap");
        for i in 0..3 {
            let line = "needle ".repeat(3000);
            std::fs::write(dir.join(format!("f{i}.txt")), line).unwrap();
        }

        let regex = build_regex(&query("needle")).unwrap();
        let result = walk_and_search(&dir, &regex, None, None);

        assert_eq!(result.match_count, 5000);
        assert!(result.truncated);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
