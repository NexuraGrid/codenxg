import { useEffect, useMemo, useState } from "react";
import { usePinGroupStore } from "../state/pinGroupStore";
import { useExplorerStore } from "../state/explorerStore";
import { existingPaths } from "../lib/tabPersistence";

const NONE: ReadonlySet<string> = new Set();

/**
 * Pin group files that no longer exist on disk. Rechecked whenever the groups
 * change or the explorer reloads a folder (the file watcher does that on
 * every create/delete/rename), and only while `enabled`.
 */
export function useMissingGroupPaths(enabled = true): ReadonlySet<string> {
  const groups = usePinGroupStore((s) => s.groups);
  const listings = useExplorerStore((s) => s.children);
  const paths = useMemo(() => [...new Set(groups.flatMap((g) => g.paths))], [groups]);
  const [missing, setMissing] = useState<ReadonlySet<string>>(NONE);

  useEffect(() => {
    if (!enabled || paths.length === 0) {
      setMissing(NONE);
      return;
    }
    let cancelled = false;
    existingPaths(paths)
      .then((present) => {
        if (!cancelled) setMissing(new Set(paths.filter((p) => !present.has(p))));
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [enabled, paths, listings]);

  return missing;
}
