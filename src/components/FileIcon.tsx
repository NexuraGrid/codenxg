import { memo } from "react";
import { fileIconUrl, folderIconUrl } from "../lib/fileIcons";

interface FileIconProps {
  name: string;
  languageId?: string;
  isFolder?: boolean;
  isOpen?: boolean;
}

export const FileIcon = memo(function FileIcon({ name, languageId, isFolder, isOpen = false }: FileIconProps) {
  const src = isFolder ? folderIconUrl(name, isOpen) : fileIconUrl(name, languageId);
  return <img className="file-ico" src={src} alt="" draggable={false} />;
});
