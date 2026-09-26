import { getModel, markSaved } from "./monacoModelRegistry";
import { writeFile } from "./tauri-api";

export async function saveFile(path: string): Promise<void> {
  const model = getModel(path);
  if (!model) return;
  const content = model.getValue();
  await writeFile(path, content);
  markSaved(path, content);
}
