import { useState, type FormEvent } from "react";
import { useGitStore } from "../state/gitStore";

interface StashDialogProps {
  onClose: () => void;
}

/** "Stash changes…": an optional message, and whether to include untracked files. */
export function StashDialog({ onClose }: StashDialogProps) {
  const { stashPush } = useGitStore.getState();
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    onClose();
    await stashPush(message.trim() || null, includeUntracked);
  }

  return (
    <div className="dialog-backdrop" onPointerDown={onClose}>
      <form
        className="dialog create-branch"
        role="dialog"
        aria-labelledby="stash-dialog-title"
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h2 id="stash-dialog-title" className="dialog__title">
          Stash changes
        </h2>

        <label className="create-branch__field">
          <span>Message (optional)</span>
          <input
            autoFocus
            value={message}
            placeholder="What are you setting aside?"
            onChange={(e) => setMessage(e.target.value)}
            spellCheck={false}
          />
        </label>

        <label className="create-branch__check">
          <input
            type="checkbox"
            checked={includeUntracked}
            onChange={(e) => setIncludeUntracked(e.target.checked)}
          />
          <span>Include untracked files</span>
        </label>

        <div className="dialog__actions">
          <button type="button" className="dialog__btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="dialog__btn is-primary">
            Stash
          </button>
        </div>
      </form>
    </div>
  );
}
