import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { createEntry, type FileEntry } from "../lib/tauri-api";
import { useEditorStore } from "../state/editorStore";
import { openPreviewTab } from "../lib/tabActions";
import { useGitStore } from "../state/gitStore";
import { useExplorerStore } from "../state/explorerStore";
import { languageFromPath } from "../lib/language";
import { deletePath, renamePath } from "../lib/explorerActions";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { FileIcon } from "./FileIcon";
import { ChevronIcon } from "./icons";
import { useTreeDrag, type DragSource } from "./useTreeDrag";

const INDENT_PX = 14;
const BASE_PADDING_PX = 10;

const indent = (depth: number) => ({ paddingLeft: `${depth * INDENT_PX + BASE_PADDING_PX}px` });

interface MenuTarget {
  /** Where "New File/Folder" creates: the folder itself, or a file's parent. */
  dir: string;
  /** The right-clicked entry; absent for the empty area (the root). */
  entry?: { path: string; parentPath: string; isDir: boolean };
}

type OpenMenu = (event: MouseEvent, target: MenuTarget) => void;

/** Single click previews the file; double click (`permanent`) keeps its tab. */
function openFile(path: string, name: string, permanent = false) {
  const tab = { path, title: name, isDirty: false, language: languageFromPath(path) };
  if (permanent) useEditorStore.getState().addTab(tab);
  else openPreviewTab(tab);
}

interface NameInputProps {
  initialName: string;
  isFolder: boolean;
  depth: number;
  leading: ReactNode;
  ariaLabel: string;
  /** Rejects with a user-facing message to keep the input open. */
  submit: (name: string) => Promise<void>;
  onCancel: () => void;
}

// Inline name editor shared by create and rename, as in VS Code's explorer:
// Enter submits, Escape cancels, clicking away submits if the name changed.
function NameInput({ initialName, isFolder, depth, leading, ariaLabel, submit, onCancel }: NameInputProps) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busyRef = useRef(false);
  // Set once finished; removing a focused input can still fire blur, which
  // must not submit a second time.
  const doneRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select the stem only ("MonacoEditor" of "MonacoEditor.tsx"), so typing
    // keeps the extension — but not for dotfiles like ".env".
    const dot = initialName.lastIndexOf(".");
    input.setSelectionRange(0, !isFolder && dot > 0 ? dot : initialName.length);
  }, [initialName, isFolder]);

  function cancel() {
    doneRef.current = true;
    onCancel();
  }

  async function commit() {
    if (busyRef.current || doneRef.current) return;
    if (!name.trim() || name.trim() === initialName) {
      cancel();
      return;
    }

    busyRef.current = true;
    try {
      await submit(name);
      doneRef.current = true;
    } catch (err) {
      setError(String(err));
      inputRef.current?.focus();
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <>
      <div className="file is-editing" style={indent(depth)}>
        {leading}
        <FileIcon name={name || (isFolder ? "folder" : "file")} isFolder={isFolder} />
        <input
          ref={inputRef}
          className={`file-create__input${error ? " has-error" : ""}`}
          value={name}
          spellCheck={false}
          aria-label={ariaLabel}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") cancel();
          }}
          onBlur={commit}
        />
      </div>
      {error && (
        <div className="file-create__error" style={indent(depth)}>
          {error}
        </div>
      )}
    </>
  );
}

function CreateSlot({ parent, depth }: { parent: string; depth: number }) {
  const creating = useExplorerStore((s) => (s.creating?.parent === parent ? s.creating : null));
  if (!creating) return null;

  const isFolder = creating.kind === "folder";
  const { refresh, cancelCreate } = useExplorerStore.getState();

  async function create(name: string) {
    const path = await createEntry(parent, name, isFolder);
    await refresh(parent);
    cancelCreate();
    if (!isFolder) openFile(path, name.trim());
  }

  return (
    <li className="file-create">
      <NameInput
        initialName=""
        isFolder={isFolder}
        depth={depth}
        leading={<span className="chevron-spacer" />}
        ariaLabel={isFolder ? "New folder name" : "New file name"}
        submit={create}
        onCancel={cancelCreate}
      />
    </li>
  );
}

interface TreeNodeProps {
  entry: FileEntry;
  parentPath: string;
  depth: number;
  onContextMenu: OpenMenu;
  onDragStart: (event: ReactPointerEvent, source: DragSource) => void;
  isClickSuppressed: () => boolean;
}

const TreeNode = memo(function TreeNode({
  entry,
  parentPath,
  depth,
  onContextMenu,
  onDragStart,
  isClickSuppressed,
}: TreeNodeProps) {
  const isOpen = useExplorerStore((s) => Boolean(s.expanded[entry.path]));
  const children = useExplorerStore((s) => s.children[entry.path]);
  const isRenaming = useExplorerStore((s) => s.renaming === entry.path);
  const isDropTarget = useExplorerStore((s) => entry.isDir && s.dropTarget === entry.path);
  const isDragSource = useExplorerStore((s) => s.dragging === entry.path);
  const isActive = useEditorStore((s) => !entry.isDir && s.activeTabPath === entry.path);
  const revealNonce = useExplorerStore((s) => (s.revealed?.path === entry.path ? s.revealed.nonce : null));
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (revealNonce !== null) rowRef.current?.scrollIntoView({ block: "center" });
  }, [revealNonce]);

  function handleClick() {
    if (isClickSuppressed()) return;
    if (entry.isDir) useExplorerStore.getState().toggle(entry.path);
    else openFile(entry.path, entry.name);
  }

  function handleDoubleClick() {
    if (isClickSuppressed() || entry.isDir) return;
    openFile(entry.path, entry.name, true);
  }

  async function rename(name: string) {
    await renamePath(entry.path, parentPath, name);
    useExplorerStore.getState().cancelRename();
  }

  const leading = entry.isDir ? <ChevronIcon open={isOpen} /> : <span className="chevron-spacer" />;
  // Folders only hint that something inside changed; files show their letter.
  const decoration = useGitStore((s) => (entry.isDir ? undefined : s.byPath[entry.path]));
  const folderChanged = useGitStore((s) => entry.isDir && Boolean(s.changedDirs[entry.path]));
  const gitClass = decoration ? `git-${decoration}` : folderChanged ? "git-dir" : undefined;

  return (
    // The whole folder block (row + open children) lights up as a drop target.
    <li className={isDropTarget ? "is-drop-target" : undefined}>
      {isRenaming ? (
        <NameInput
          initialName={entry.name}
          isFolder={entry.isDir}
          depth={depth}
          leading={leading}
          ariaLabel={`Rename ${entry.name}`}
          submit={rename}
          onCancel={useExplorerStore.getState().cancelRename}
        />
      ) : (
        <div
          ref={rowRef}
          className={`file${isActive ? " is-active" : ""}${isDragSource ? " is-drag-source" : ""}${revealNonce !== null ? " is-revealed" : ""}`}
          style={indent(depth)}
          data-drop-dir={entry.isDir ? entry.path : parentPath}
          data-folder={entry.isDir ? entry.path : undefined}
          onPointerDown={(e) =>
            onDragStart(e, { path: entry.path, name: entry.name, isDir: entry.isDir, parentPath })
          }
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onContextMenu={(e) =>
            onContextMenu(e, {
              dir: entry.isDir ? entry.path : parentPath,
              entry: { path: entry.path, parentPath, isDir: entry.isDir },
            })
          }
        >
          {leading}
          <FileIcon name={entry.name} isFolder={entry.isDir} isOpen={isOpen} />
          <span className={gitClass}>{entry.name}</span>
          {decoration && <span className={`file__git ${gitClass}`}>{decoration}</span>}
        </div>
      )}
      {entry.isDir && isOpen && (
        <ul className="file-list">
          <CreateSlot parent={entry.path} depth={depth + 1} />
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              parentPath={entry.path}
              depth={depth + 1}
              onContextMenu={onContextMenu}
              onDragStart={onDragStart}
              isClickSuppressed={isClickSuppressed}
            />
          ))}
        </ul>
      )}
    </li>
  );
});

interface FileTreeProps {
  rootPath: string;
}

export function FileTree({ rootPath }: FileTreeProps) {
  const rootEntries = useExplorerStore((s) => s.children[rootPath]);
  const isRootDropTarget = useExplorerStore((s) => s.dropTarget === rootPath);
  const { ghost, placeGhost, beginPointer, isClickSuppressed } = useTreeDrag();
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    useExplorerStore.getState().init(rootPath);
  }, [rootPath]);

  const openMenu = useCallback<OpenMenu>((event, target) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, target });
  }, []);

  function menuEntries({ dir, entry }: MenuTarget): ContextMenuEntry[] {
    const { startCreate, startRename, refresh } = useExplorerStore.getState();
    const entries: ContextMenuEntry[] = [
      { type: "item", label: "New File…", onSelect: () => startCreate(dir, "file") },
      { type: "item", label: "New Folder…", onSelect: () => startCreate(dir, "folder") },
    ];
    if (entry) {
      entries.push(
        { type: "separator" },
        { type: "item", label: "Rename…", onSelect: () => startRename(entry.path) },
        {
          type: "item",
          label: "Delete",
          onSelect: () => deletePath(entry.path, entry.isDir, entry.parentPath).catch(console.error),
        },
      );
    }
    entries.push(
      { type: "separator" },
      { type: "item", label: "Refresh", onSelect: () => refresh(dir).catch(console.error) },
    );
    return entries;
  }

  return (
    // Right-clicking (or dropping on) the empty space below the entries
    // targets the root.
    <ul
      className={`file-list file-tree${isRootDropTarget ? " is-drop-target" : ""}`}
      data-drop-dir={rootPath}
      onPointerDown={() => useExplorerStore.getState().clearRevealed()}
      onContextMenu={(e) => openMenu(e, { dir: rootPath })}
    >
      <CreateSlot parent={rootPath} depth={0} />
      {rootEntries?.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          parentPath={rootPath}
          depth={0}
          onContextMenu={openMenu}
          onDragStart={beginPointer}
          isClickSuppressed={isClickSuppressed}
        />
      ))}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.target)} onClose={closeMenu} />}
      {ghost &&
        createPortal(
          <div ref={placeGhost} className="drag-ghost" aria-hidden="true">
            <FileIcon name={ghost.name} isFolder={ghost.isDir} />
            <span>{ghost.name}</span>
          </div>,
          document.body,
        )}
    </ul>
  );
}
