import manifest from "material-icon-theme/dist/material-icons.json";

interface IconManifest {
  iconDefinitions: Record<string, { iconPath: string }>;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  languageIds: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
}

const icons = manifest as unknown as IconManifest;

// URLs only — each SVG is fetched by the browser the first time it is shown.
const iconUrls = import.meta.glob<string>("/node_modules/material-icon-theme/icons/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
});

function urlFor(iconName: string, fallback: string): string {
  const iconPath = (icons.iconDefinitions[iconName] ?? icons.iconDefinitions[fallback]).iconPath;
  const fileName = iconPath.split("/").pop();
  return iconUrls[`/node_modules/material-icon-theme/icons/${fileName}`];
}

// Same precedence as VS Code's icon themes: exact file name, then the longest
// matching extension ("test.ts" before "ts"), then the editor language.
export function fileIconUrl(name: string, languageId?: string): string {
  const lower = name.toLowerCase();
  let icon = icons.fileNames[lower];

  const parts = lower.split(".");
  for (let i = 1; !icon && i < parts.length; i++) {
    icon = icons.fileExtensions[parts.slice(i).join(".")];
  }

  if (!icon && languageId) icon = icons.languageIds[languageId];
  return urlFor(icon ?? icons.file, icons.file);
}

export function folderIconUrl(name: string, isOpen: boolean): string {
  const lower = name.toLowerCase();
  const fallback = isOpen ? icons.folderExpanded : icons.folder;
  const icon = (isOpen ? icons.folderNamesExpanded : icons.folderNames)[lower];
  return urlFor(icon ?? fallback, fallback);
}
