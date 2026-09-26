import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { createTerminal, writeToTerminal, resizeTerminal } from "../lib/tauri-api";
import { useTerminalStore } from "../state/terminalStore";

// The default DOM renderer is slow under WebKitGTK; WebGL renders on the GPU.
// If WebGL is unavailable or its context is lost, xterm keeps the DOM renderer.
function tryEnableWebgl(terminal: Terminal) {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    terminal.loadAddon(webgl);
  } catch (error) {
    console.warn("WebGL renderer unavailable, using DOM renderer", error);
  }
}

// VS Code's bindings: Ctrl+C copies when there is a selection and otherwise
// reaches the shell as SIGINT; Ctrl+V pastes (xterm would send ^V). The
// clipboard goes through the native plugin, the webview's API is unreliable.
function handleClipboardKeys(terminal: Terminal, event: KeyboardEvent): boolean {
  if (event.type !== "keydown" || !(event.ctrlKey || event.metaKey) || event.altKey) return true;
  const key = event.key.toLowerCase();

  if (key === "c" && (event.shiftKey || terminal.hasSelection())) {
    event.preventDefault();
    if (terminal.hasSelection()) {
      writeText(terminal.getSelection()).catch(console.error);
      terminal.clearSelection();
    }
    return false;
  }

  if (key === "v") {
    // preventDefault also stops the webview's own paste event: no double paste.
    event.preventDefault();
    readText()
      .then((text) => {
        if (text) terminal.paste(text);
      })
      .catch(console.error);
    return false;
  }

  return true;
}

interface TerminalPanelProps {
  sessionId: string;
  cwd: string;
  /** Inactive sessions stay mounted (shell and scrollback alive), just hidden. */
  isActive: boolean;
}

export function TerminalPanel({ sessionId, cwd, isActive }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      theme: {
        background: "#121212",
        foreground: "#d8d8d8",
        cursor: "#6aa8ff",
        selectionBackground: "#3b82f633",
      },
      fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13.2,
      lineHeight: 17.8 / 13.2,
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    tryEnableWebgl(terminal);
    terminal.attachCustomKeyEventHandler((event) => handleClipboardKeys(terminal, event));
    terminalRef.current = terminal;

    const isVisible = () => container.clientWidth > 0 && container.clientHeight > 0;

    let cancelled = false;
    let started = false;

    // Order matters: measure with the real font, then spawn the shell at that
    // size with its output channel already attached. A default size makes the
    // shell repaint its prompt on the first resize, and missing output loses
    // its startup terminal queries (late replies then show up as typed text).
    async function start() {
      await document.fonts.ready;
      if (cancelled) return;
      if (isVisible()) fitAddon.fit();

      await createTerminal(
        sessionId,
        cwd,
        terminal.rows,
        terminal.cols,
        (chunk) => {
          if (!cancelled) terminal.write(chunk);
        },
        () => useTerminalStore.getState().forgetSession(sessionId),
      );
      // No-op for a fresh session; re-syncs a session that survived a reload.
      await resizeTerminal(sessionId, terminal.rows, terminal.cols);
      started = true;
    }

    start().catch(console.error);

    const dataDisposable = terminal.onData((data) => {
      if (started) writeToTerminal(sessionId, data).catch(console.error);
    });

    const resizeDisposable = terminal.onResize(({ rows, cols }) => {
      if (started) resizeTerminal(sessionId, rows, cols).catch(console.error);
    });

    // Panels resize independently of the window (dragging the gap, collapsing
    // the output), so observe the container. One fit per frame is enough.
    let frame = 0;
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (isVisible()) fitAddon.fit();
      });
    });
    resizeObserver.observe(container);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      // Deliberately NOT calling closeTerminal(sessionId) here: React StrictMode's
      // dev-mode double-invoke would kill the PTY right before the real remount
      // reattaches to it. Shells are killed explicitly by the terminal store.
    };
  }, [sessionId, cwd]);

  useEffect(() => {
    if (isActive) terminalRef.current?.focus();
  }, [isActive]);

  // Hidden with display:none, so the ResizeObserver refits it when shown.
  return <div ref={containerRef} className={`terminal-panel${isActive ? "" : " is-hidden"}`} />;
}
