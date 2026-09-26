import { useEffect, useState, type FormEvent } from "react";
import { useGitStore } from "../state/gitStore";

// Git's rules, checked as you type so the button can explain itself; the
// backend runs `git check-ref-format` as the final word.
function nameProblem(name: string, existing: Set<string>): string | null {
  if (!name) return null;
  if (/\s/.test(name)) return "Branch names can't contain spaces (use - or /).";
  if (/[~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$/.test(name)) return "That isn't a valid branch name.";
  if (existing.has(name)) return `A branch named "${name}" already exists.`;
  return null;
}

interface CreateBranchDialogProps {
  initialName?: string;
  onClose: () => void;
}

export function CreateBranchDialog({ initialName = "", onClose }: CreateBranchDialogProps) {
  const branches = useGitStore((s) => s.branches);
  const current = useGitStore((s) => s.status?.branch ?? null);
  const { loadBranches, createBranch } = useGitStore.getState();
  const [name, setName] = useState(initialName);
  const [base, setBase] = useState<string>(""); // "" = the current branch
  const [switchTo, setSwitchTo] = useState(true);

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const trimmed = name.trim();
  const problem = nameProblem(trimmed, new Set(branches.filter((b) => !b.isRemote).map((b) => b.name)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || problem) return;
    onClose();
    await createBranch(trimmed, base || null, switchTo);
  }

  return (
    <div className="dialog-backdrop" onPointerDown={onClose}>
      <form
        className="dialog create-branch"
        role="dialog"
        aria-labelledby="create-branch-title"
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h2 id="create-branch-title" className="dialog__title">
          Create branch
        </h2>

        <label className="create-branch__field">
          <span>Name</span>
          <input
            autoFocus
            value={name}
            placeholder="feature/my-change"
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
          />
        </label>
        {problem && <p className="create-branch__problem">{problem}</p>}

        <label className="create-branch__field">
          <span>From</span>
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            <option value="">{current ? `${current} (current)` : "Current commit"}</option>
            {branches
              .filter((b) => !b.isCurrent)
              .map((b) => (
                <option key={`${b.isRemote}:${b.name}`} value={b.name}>
                  {b.name}
                  {b.isRemote ? " (remote)" : ""}
                </option>
              ))}
          </select>
        </label>

        <label className="create-branch__check">
          <input type="checkbox" checked={switchTo} onChange={(e) => setSwitchTo(e.target.checked)} />
          <span>Switch to it right away</span>
        </label>

        <div className="dialog__actions">
          <button type="button" className="dialog__btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="dialog__btn is-primary" disabled={!trimmed || problem !== null}>
            {switchTo ? "Create & Switch" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
