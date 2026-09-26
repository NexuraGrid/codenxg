import type { MouseEvent } from "react";
import { useTerminalStore } from "../state/terminalStore";
import { CloseIcon, PlusIcon, TerminalIcon } from "./icons";

export function TerminalTabs() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const createSession = useTerminalStore((s) => s.createSession);
  const closeSession = useTerminalStore((s) => s.closeSession);

  function handleClose(event: MouseEvent, id: string) {
    event.stopPropagation();
    closeSession(id);
  }

  return (
    <div className="term-tabs">
      <div className="term-tabs__list">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`term-tab${session.id === activeSessionId ? " is-active" : ""}`}
            onClick={() => setActiveSession(session.id)}
            onAuxClick={(e) => e.button === 1 && closeSession(session.id)}
          >
            <TerminalIcon className="term-tab__icon" />
            <span>{session.title}</span>
            <button className="tab__close" title="Kill terminal" onClick={(e) => handleClose(e, session.id)}>
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>
      <button className="icon-btn" title="New terminal (Ctrl+Shift+`)" onClick={createSession}>
        <PlusIcon />
      </button>
    </div>
  );
}
