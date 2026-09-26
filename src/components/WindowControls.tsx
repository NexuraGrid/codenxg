import { getCurrentWindow } from "@tauri-apps/api/window";
import { CloseIcon, MaximizeIcon, MinimizeIcon } from "./icons";

export function WindowControls() {
  const appWindow = getCurrentWindow();

  return (
    <div className="window-controls">
      <button className="icon-btn" title="Minimize" onClick={() => appWindow.minimize()}>
        <MinimizeIcon />
      </button>
      <button className="icon-btn" title="Maximize" onClick={() => appWindow.toggleMaximize()}>
        <MaximizeIcon />
      </button>
      <button className="icon-btn is-close" title="Close" onClick={() => appWindow.close()}>
        <CloseIcon />
      </button>
    </div>
  );
}
