import { Fragment, useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from "react-resizable-panels";
import { equalGroupSizes, useEditorStore } from "../state/editorStore";
import { EditorTabs } from "./EditorTabs";
import { MonacoEditor } from "./MonacoEditor";

/**
 * The editor area: one or more editor groups side by side, each with its own
 * tab bar and editor, split by draggable dividers (double-click: equal
 * widths). Always a PanelGroup — even with one group — so splitting never
 * remounts the first group's editor.
 */
export function EditorGroups() {
  const groups = useEditorStore((s) => s.groups);
  const activeGroupId = useEditorStore((s) => s.activeGroupId);
  const sizes = useEditorStore((s) => s.groupSizes);
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null);
  const isSplit = groups.length > 1;

  // When groups come or go (split, restore, close), apply the store's sizes:
  // restored widths, or an even split for a new group.
  const groupKey = groups.map((g) => g.id).join("|");
  useEffect(() => {
    const handle = panelGroupRef.current;
    const wanted = useEditorStore.getState().groupSizes;
    const current = handle?.getLayout() ?? [];
    if (handle && current.length === wanted.length && current.some((size, i) => Math.abs(size - wanted[i]) > 0.5)) {
      handle.setLayout(wanted);
    }
  }, [groupKey]);

  return (
    <PanelGroup
      ref={panelGroupRef}
      direction="horizontal"
      className="editor-groups"
      onLayout={(layout) => useEditorStore.getState().setGroupSizes(layout)}
    >
      {groups.map((group, index) => (
        <Fragment key={group.id}>
          {index > 0 && (
            <PanelResizeHandle
              className="editor-groups__divider"
              onDoubleClick={() => panelGroupRef.current?.setLayout(equalGroupSizes(groups.length))}
            />
          )}
          <Panel id={group.id} order={index} defaultSize={sizes[index]} minSize={15}>
            <section
              className={`editor-group${isSplit ? (group.id === activeGroupId ? " is-active" : " is-inactive") : ""}`}
              // Capture: a click anywhere in the group (a preview, the
              // settings view, an empty group) focuses it before any handler runs.
              onMouseDownCapture={() => useEditorStore.getState().focusGroup(group.id)}
            >
              <EditorTabs
                groupId={group.id}
                showPinGroupSwitcher={index === 0}
                showWindowControls={index === groups.length - 1}
              />
              <div className="editor__body">
                <MonacoEditor groupId={group.id} />
              </div>
            </section>
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}
