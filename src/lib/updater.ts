import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { showDialog } from "../state/dialogStore";
import { useUpdateStore } from "../state/updateStore";

interface CheckOptions {
  /** Startup checks stay quiet unless an update exists. */
  silent: boolean;
}

const MAX_NOTES_LENGTH = 400;

function describeUpdate(version: string, currentVersion: string, notes?: string): string {
  const header = `Version ${version} is available (you have ${currentVersion}).`;
  const trimmed = notes?.trim();
  if (!trimmed) return header;
  const body = trimmed.length > MAX_NOTES_LENGTH ? `${trimmed.slice(0, MAX_NOTES_LENGTH)}…` : trimmed;
  return `${header}\n\n${body}`;
}

async function notify(title: string, message: string) {
  await showDialog({
    title,
    message,
    buttons: [{ label: "OK", value: "ok", variant: "primary" }],
    cancelValue: "ok",
  });
}

export async function checkForUpdates({ silent }: CheckOptions): Promise<void> {
  const store = useUpdateStore.getState();
  if (store.phase !== "idle") return;

  store.setPhase("checking");
  try {
    const update = await check();
    if (!update) {
      store.setPhase("idle");
      if (!silent) await notify("You're up to date", "You already have the latest version.");
      return;
    }

    store.setPhase("idle");
    const choice = await showDialog({
      title: "Update available",
      message: describeUpdate(update.version, update.currentVersion, update.body),
      buttons: [
        { label: "Later", value: "later" },
        { label: "Install and restart", value: "install", variant: "primary" },
      ],
      cancelValue: "later",
    });
    if (choice !== "install") return;

    let downloaded = 0;
    let total = 0;
    store.setPhase("downloading");
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        useUpdateStore.getState().setProgress(total > 0 ? downloaded / total : null);
      } else {
        useUpdateStore.getState().setPhase("installing");
      }
    });
    await relaunch();
  } catch (error) {
    console.error("Update check failed", error);
    useUpdateStore.getState().setPhase("idle");
    if (!silent) await notify("Update failed", "Could not check for or install updates. Try again later.");
  }
}
