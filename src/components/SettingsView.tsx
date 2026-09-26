import { useSettingsStore } from "../state/settingsStore";
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
      </section>
    </div>
  );
}
