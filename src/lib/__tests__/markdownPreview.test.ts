import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore, type EditorTab } from "../../state/editorStore";
import {
  canToggleMarkdownPreview,
  isMarkdownPath,
  isMarkdownSourceTab,
  markdownPreviewTab,
  openMarkdownPreview,
  toggleMarkdownPreview,
} from "../markdownPreview";
import { isPersistableTab } from "../persistedTabs";

function file(path: string, overrides: Partial<EditorTab> = {}): EditorTab {
  return { path, title: path.split("/").pop()!, isDirty: false, language: "markdown", ...overrides };
}

const store = () => useEditorStore.getState();

beforeEach(() => store().reset());

describe("markdown preview tabs", () => {
  it("recognizes Markdown files by extension", () => {
    expect(isMarkdownPath("/ws/README.md")).toBe(true);
    expect(isMarkdownPath("/ws/notes.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("/ws/main.ts")).toBe(false);
  });

  it("only treats real Markdown file tabs as preview sources", () => {
    expect(isMarkdownSourceTab(file("/ws/README.md"))).toBe(true);
    expect(isMarkdownSourceTab(markdownPreviewTab("/ws/README.md"))).toBe(false);
    const commit = { hash: "h", shortHash: "h", file: "README.md", origFile: null };
    expect(isMarkdownSourceTab(file("commit:h:README.md", { commit }))).toBe(false);
  });

  it("keys the preview apart from the file and never persists it", () => {
    const tab = markdownPreviewTab("/ws/README.md");
    expect(tab).toMatchObject({ path: "markdown-preview:/ws/README.md", title: "Preview README.md" });
    expect(tab.markdownPreview).toEqual({ source: "/ws/README.md" });
    expect(isPersistableTab(tab)).toBe(false);
  });

  it("opens the preview once and focuses it again later", () => {
    store().addTab(file("/ws/README.md"));
    openMarkdownPreview("/ws/README.md");
    store().setActiveTab("/ws/README.md");
    openMarkdownPreview("/ws/README.md");
    expect(store().tabs.map((t) => t.path)).toEqual(["/ws/README.md", "markdown-preview:/ws/README.md"]);
    expect(store().activeTabPath).toBe("markdown-preview:/ws/README.md");
  });

  it("toggles between a Markdown file and its preview", () => {
    store().addTab(file("/ws/README.md"));
    expect(toggleMarkdownPreview()).toBe(true);
    expect(store().activeTabPath).toBe("markdown-preview:/ws/README.md");
    expect(toggleMarkdownPreview()).toBe(true);
    expect(store().activeTabPath).toBe("/ws/README.md");
  });

  it("leaves Ctrl+Shift+V alone for other files", () => {
    store().addTab(file("/ws/main.ts", { language: "typescript" }));
    expect(canToggleMarkdownPreview()).toBe(false);
    expect(toggleMarkdownPreview()).toBe(false);
    expect(store().tabs).toHaveLength(1);
  });

  it("follows its source file through a rename", () => {
    openMarkdownPreview("/ws/docs/README.md");
    store().rebasePaths("/ws/docs", "/ws/guide");
    const [tab] = store().tabs;
    expect(tab.path).toBe("markdown-preview:/ws/guide/README.md");
    expect(tab.markdownPreview).toEqual({ source: "/ws/guide/README.md" });
    expect(store().activeTabPath).toBe("markdown-preview:/ws/guide/README.md");
  });
});
