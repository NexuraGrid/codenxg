import { dirname, isSameOrInside } from "./paths";
import { readImageData } from "./tauri-api";

/** Where a Markdown image's `src` points, once checked. */
export type ImageSource =
  | { kind: "local"; path: string; mime: string }
  | { kind: "url"; url: string };

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  // An SVG shown through <img> never runs its scripts.
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

export function imageMime(path: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext ? IMAGE_MIME[ext] : undefined;
}

/** Collapses `.` and `..` segments; never climbs above the path's first segment. */
function normalizeSegments(path: string, sep: string): string {
  const [head, ...rest] = path.split(/[\\/]/);
  const out: string[] = [];
  for (const segment of rest) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return [head, ...out].join(sep);
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Resolves an image `src` from the Markdown file at `markdownPath`: https and
 * `data:image/` URLs load as they are; anything else scheme-bearing is refused
 * (null). A relative path is taken from the file's folder, and one starting
 * with `/` from the workspace root, like on GitHub. Whether a local path is
 * really inside the workspace is decided on the Rust side (read_image_data).
 */
export function resolveImageSource(src: string, markdownPath: string, root: string | null): ImageSource | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (/^https:\/\//i.test(trimmed)) return { kind: "url", url: trimmed };
  if (/^data:image\//i.test(trimmed)) return { kind: "url", url: trimmed };
  // Any other scheme (http:, file:, javascript:…); a Windows drive letter isn't one.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) return null;

  const pathPart = decode(trimmed.replace(/[?#].*$/, ""));
  const sep = markdownPath.includes("\\") && !markdownPath.includes("/") ? "\\" : "/";
  let joined: string;
  if (/^[a-z]:[\\/]/i.test(pathPart)) joined = pathPart;
  else if (pathPart.startsWith("/")) joined = root && !isSameOrInside(pathPart, root) ? `${root}${pathPart}` : pathPart;
  else joined = `${dirname(markdownPath)}${sep}${pathPart}`;

  const path = normalizeSegments(joined, sep);
  const mime = imageMime(path);
  return mime ? { kind: "local", path, mime } : null;
}

// Blob URLs of local images, shared while any preview shows them. Re-rendering
// a document as it's typed remounts images; a short grace period before
// revoking keeps that from re-reading every file on each keystroke.
const RELEASE_DELAY_MS = 5000;

interface CachedImage {
  url: Promise<string>;
  refs: number;
  revokeTimer?: ReturnType<typeof setTimeout>;
}

const cache = new Map<string, CachedImage>();

/** A blob: URL for a local image; pair every call with `releaseLocalImage`. */
export function acquireLocalImage(path: string, mime: string): Promise<string> {
  let entry = cache.get(path);
  if (!entry) {
    const url = readImageData(path).then((bytes) => URL.createObjectURL(new Blob([bytes], { type: mime })));
    const created: CachedImage = { url, refs: 0 };
    entry = created;
    cache.set(path, created);
    // A failed read isn't cached: the next render may succeed (file added, workspace fixed).
    url.catch(() => {
      if (cache.get(path) === created) cache.delete(path);
    });
  }
  clearTimeout(entry.revokeTimer);
  entry.revokeTimer = undefined;
  entry.refs += 1;
  return entry.url;
}

export function releaseLocalImage(path: string): void {
  const entry = cache.get(path);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.revokeTimer = setTimeout(() => {
    if (cache.get(path) !== entry || entry.refs > 0) return;
    cache.delete(path);
    entry.url.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }, RELEASE_DELAY_MS);
}
