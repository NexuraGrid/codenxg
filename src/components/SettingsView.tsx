import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useSettingsStore } from "../state/settingsStore";
import { useUpdateStore } from "../state/updateStore";
import { checkForUpdates } from "../lib/updater";
import { installCli } from "../lib/tauri-api";
import { BUNDLED_FONTS, type AutoSaveMode } from "../lib/settingsSchema";

const CUSTOM_FONT = "__custom__";

interface FontFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}

function FontField({ id, label, value, onChange }: FontFieldProps) {
  const isPreset = (BUNDLED_FONTS as readonly string[]).includes(value);

  return (
    <label className="settings__field" htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        value={isPreset ? value : CUSTOM_FONT}
        onChange={(e) => {
          if (e.target.value !== CUSTOM_FONT) onChange(e.target.value);
        }}
      >
        {BUNDLED_FONTS.map((font) => (
          <option key={font} value={font}>
            {font}
          </option>
        ))}
        <option value={CUSTOM_FONT}>Custom…</option>
      </select>
      {!isPreset && (
        <input value={value} placeholder="Font family name" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function UpdatesSection() {
  const [version, setVersion] = useState("");
  const phase = useUpdateStore((s) => s.phase);
  const progress = useUpdateStore((s) => s.progress);

  useEffect(() => {
    getVersion().then(setVersion, () => setVersion(""));
  }, []);

  const label =
    phase === "checking"
      ? "Checking…"
      : phase === "downloading"
        ? `Downloading${progress === null ? "…" : ` ${Math.round(progress * 100)}%`}`
        : phase === "installing"
          ? "Installing…"
          : "Check for updates";

  return (
    <section className="settings__section">
      <h3>Updates</h3>
      <div className="settings__field">
        <span>Current version{version ? ` ${version}` : ""}</span>
        <button className="dialog__btn is-primary" disabled={phase !== "idle"} onClick={() => void checkForUpdates({ silent: false })}>
          {label}
        </button>
      </div>
    </section>
  );
}

function CommandLineSection() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function handleInstall() {
    setBusy(true);
    try {
      setStatus(await installCli());
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings__section">
      <h3>Command line</h3>
      <div className="settings__field">
        <span>Open folders from a terminal with `codenxg .`</span>
        <button className="dialog__btn is-primary" disabled={busy} onClick={() => void handleInstall()}>
          Install &apos;codenxg&apos; command
        </button>
      </div>
      {status && <p className="dialog__message">{status}</p>}
    </section>
  );
}

export function SettingsView() {
  const settings = useSettingsStore((s) => s.settings);
  const { updateEditor, updateFiles, updateTerminal } = useSettingsStore.getState();

  return (
    <div className="settings">
      <h2 className="settings__title">Settings</h2>

      <section className="settings__section">
        <h3>Editor</h3>

        <FontField
          id="editor-font"
          label="Font family"
          value={settings.editor.fontFamily}
          onChange={(fontFamily) => updateEditor({ fontFamily })}
        />

        <label className="settings__field" htmlFor="editor-font-size">
          <span>Font size</span>
          <input
            id="editor-font-size"
            type="number"
            min={6}
            max={96}
            step={0.1}
            value={settings.editor.fontSize}
            onChange={(e) => updateEditor({ fontSize: Number(e.target.value) })}
          />
        </label>

        <label className="settings__field" htmlFor="editor-line-height">
          <span>Line height</span>
          <input
            id="editor-line-height"
            type="number"
            min={6}
            max={160}
            step={0.1}
            value={settings.editor.lineHeight}
            onChange={(e) => updateEditor({ lineHeight: Number(e.target.value) })}
          />
        </label>

        <label className="settings__field" htmlFor="editor-tab-size">
          <span>Tab size</span>
          <input
            id="editor-tab-size"
            type="number"
            min={1}
            max={16}
            disabled={settings.editor.detectIndentation}
            value={settings.editor.tabSize}
            onChange={(e) => updateEditor({ tabSize: Number(e.target.value) })}
          />
        </label>

        <label className="settings__check">
          <input
            type="checkbox"
            checked={settings.editor.insertSpaces}
            disabled={settings.editor.detectIndentation}
            onChange={(e) => updateEditor({ insertSpaces: e.target.checked })}
          />
          <span>Insert spaces when pressing Tab</span>
        </label>

        <label className="settings__check">
          <input
            type="checkbox"
            checked={settings.editor.detectIndentation}
            onChange={(e) => updateEditor({ detectIndentation: e.target.checked })}
          />
          <span>Detect indentation from file content</span>
        </label>

        <label className="settings__check">
          <input type="checkbox" checked={settings.editor.wordWrap} onChange={(e) => updateEditor({ wordWrap: e.target.checked })} />
          <span>Word wrap</span>
        </label>

        <label className="settings__check">
          <input type="checkbox" checked={settings.editor.minimap} onChange={(e) => updateEditor({ minimap: e.target.checked })} />
          <span>Show minimap</span>
        </label>

        <label className="settings__check">
          <input
            type="checkbox"
            checked={settings.editor.renderWhitespace}
            onChange={(e) => updateEditor({ renderWhitespace: e.target.checked })}
          />
          <span>Render whitespace characters</span>
        </label>

        <label className="settings__check">
          <input
            type="checkbox"
            checked={settings.editor.formatOnSave}
            onChange={(e) => updateEditor({ formatOnSave: e.target.checked })}
          />
          <span>Format on save</span>
        </label>
      </section>

      <section className="settings__section">
        <h3>Files</h3>

        <label className="settings__field" htmlFor="files-autosave">
          <span>Auto save</span>
          <select
            id="files-autosave"
            value={settings.files.autoSave}
            onChange={(e) => updateFiles({ autoSave: e.target.value as AutoSaveMode })}
          >
            <option value="off">Off</option>
            <option value="afterDelay">After a delay</option>
            <option value="onFocusChange">When focus changes</option>
          </select>
        </label>

        {settings.files.autoSave === "afterDelay" && (
          <label className="settings__field" htmlFor="files-autosave-delay">
            <span>Delay (ms)</span>
            <input
              id="files-autosave-delay"
              type="number"
              min={100}
              max={60000}
              step={100}
              value={settings.files.autoSaveDelayMs}
              onChange={(e) => updateFiles({ autoSaveDelayMs: Number(e.target.value) })}
            />
          </label>
        )}
      </section>

      <section className="settings__section">
        <h3>Terminal</h3>

        <FontField
          id="terminal-font"
          label="Font family"
          value={settings.terminal.fontFamily}
          onChange={(fontFamily) => updateTerminal({ fontFamily })}
        />

        <label className="settings__field" htmlFor="terminal-font-size">
          <span>Font size</span>
          <input
            id="terminal-font-size"
            type="number"
            min={6}
            max={96}
            step={0.1}
            value={settings.terminal.fontSize}
            onChange={(e) => updateTerminal({ fontSize: Number(e.target.value) })}
          />
        </label>

        <label className="settings__field" htmlFor="terminal-shell-path">
          <span>Shell path</span>
          <input
            id="terminal-shell-path"
            placeholder="Auto-detect"
            spellCheck={false}
            value={settings.terminal.shellPath}
            onChange={(e) => updateTerminal({ shellPath: e.target.value })}
          />
        </label>

        <label className="settings__field" htmlFor="terminal-shell-args">
          <span>Shell args</span>
          <input
            id="terminal-shell-args"
            placeholder="e.g. -NoLogo"
            spellCheck={false}
            value={settings.terminal.shellArgs}
            onChange={(e) => updateTerminal({ shellArgs: e.target.value })}
          />
        </label>
      </section>

      <CommandLineSection />

      <UpdatesSection />
    </div>
  );
}
