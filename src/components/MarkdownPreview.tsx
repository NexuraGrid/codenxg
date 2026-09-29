import { useDeferredValue, useEffect, useMemo, useState, type ComponentProps, type MouseEvent } from "react";
import * as monaco from "monaco-editor";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getModel } from "../lib/monacoModelRegistry";
import { readFile } from "../lib/tauri-api";
import { acquireLocalImage, releaseLocalImage, resolveImageSource, type ImageSource } from "../lib/markdownImages";
import { useExplorerStore } from "../state/explorerStore";

// Raw HTML stays disabled (react-markdown's default): no rehype-raw.
const REMARK_PLUGINS = [remarkGfm];

/**
 * Follows the live Monaco model of `source` when the file is open, so the
 * preview updates as the user types; otherwise shows the file as on disk.
 */
function useMarkdownSource(source: string): { text: string; error: string | null } {
  const [text, setText] = useState(() => getModel(source)?.getValue() ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let subscriptions: monaco.IDisposable[] = [];
    const uri = monaco.Uri.file(source).toString();

    function follow(model: monaco.editor.ITextModel) {
      setText(model.getValue());
      setError(null);
      subscriptions = [
        model.onDidChangeContent(() => setText(model.getValue())),
        // Closing the file's tab disposes its model: keep the last text shown.
        model.onWillDispose(() => {
          for (const s of subscriptions) s.dispose();
          subscriptions = [];
        }),
      ];
    }

    const model = getModel(source);
    if (model) {
      follow(model);
    } else {
      readFile(source)
        .then((content) => !cancelled && subscriptions.length === 0 && setText(content))
        .catch((e: unknown) => !cancelled && setError(String(e)));
    }
    // Opening the file while its preview is showing switches to live updates.
    const created = monaco.editor.onDidCreateModel((m) => {
      if (subscriptions.length === 0 && m.uri.toString() === uri) follow(m);
    });

    return () => {
      cancelled = true;
      created.dispose();
      for (const s of subscriptions) s.dispose();
    };
  }, [source]);

  return { text, error };
}

/** The Monaco language for a fence tag like `ts`, `typescript` or `sh`. */
function monacoLanguageFor(tag: string): string | undefined {
  const wanted = tag.toLowerCase();
  const languages = monaco.languages.getLanguages();
  return (
    languages.find((l) => l.id === wanted) ??
    languages.find((l) => l.aliases?.some((a) => a.toLowerCase() === wanted)) ??
    languages.find((l) => l.extensions?.includes(`.${wanted}`))
  )?.id;
}

function ColorizedCode({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // colorize escapes the text itself; its output is only Monaco's token spans.
    monaco.editor
      .colorize(code, language, { tabSize: 4 })
      .then((result) => !cancelled && setHtml(result))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (html === null) return <code>{code}</code>;
  return <code dangerouslySetInnerHTML={{ __html: html }} />;
}

function Code({ className, children, ...rest }: ComponentProps<"code">) {
  const tag = /language-([\w+#-]+)/.exec(className ?? "")?.[1];
  const language = tag ? monacoLanguageFor(tag) : undefined;
  if (language && typeof children === "string") {
    return <ColorizedCode code={children.replace(/\n$/, "")} language={language} />;
  }
  return (
    <code className={className} {...rest}>
      {children}
    </code>
  );
}

function Link({ href, children, ...rest }: ComponentProps<"a">) {
  function handleClick(event: MouseEvent) {
    // Never navigate the app's own webview away from the editor.
    event.preventDefault();
    if (href && /^(https?:|mailto:)/i.test(href)) void openUrl(href).catch(console.error);
  }
  return (
    <a href={href} title={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}

function ImagePlaceholder({ alt, src }: { alt?: string; src?: string }) {
  return (
    <span className="md-preview__img" title={src}>
      [image{alt ? `: ${alt}` : ""}]
    </span>
  );
}

/**
 * The asset protocol stays off: workspace images come through
 * read_image_data as blob: URLs, https and data: images load directly (see
 * the CSP's img-src). Anything else, or anything that fails, shows as its
 * alt text.
 */
function PreviewImage({ image, alt, src, title }: { image: ImageSource; alt?: string; src: string; title?: string }) {
  const [url, setUrl] = useState<string | null>(image.kind === "url" ? image.url : null);
  const [failed, setFailed] = useState(false);
  const localPath = image.kind === "local" ? image.path : null;
  const localMime = image.kind === "local" ? image.mime : null;

  useEffect(() => {
    if (localPath === null || localMime === null) return;
    let cancelled = false;
    // A failed read drops its own cache entry: releasing it then could
    // release someone else's newer one for the same path.
    let held = true;
    acquireLocalImage(localPath, localMime)
      .then((blobUrl) => !cancelled && setUrl(blobUrl))
      .catch(() => {
        held = false;
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (held) releaseLocalImage(localPath);
    };
  }, [localPath, localMime]);

  if (failed) return <ImagePlaceholder alt={alt} src={src} />;
  if (url === null) return <span className="md-preview__img-loading" title={src} />;
  return (
    <img
      className="md-preview__image"
      src={url}
      alt={alt ?? ""}
      title={title ?? src}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function makeComponents(source: string, root: string | null): Components {
  function Image({ alt, src, title }: ComponentProps<"img">) {
    const raw = typeof src === "string" ? src : "";
    const image = raw ? resolveImageSource(raw, source, root) : null;
    if (!image) return <ImagePlaceholder alt={alt} src={raw || undefined} />;
    // Keyed by where it points, so a changed src starts over (and a failed one retries).
    const key = image.kind === "local" ? image.path : image.url;
    return <PreviewImage key={key} image={image} alt={alt} src={raw} title={title} />;
  }
  return { code: Code, a: Link, img: Image };
}

export function MarkdownPreview({ source }: { source: string }) {
  const { text, error } = useMarkdownSource(source);
  const root = useExplorerStore((s) => s.root);
  // Stable per file: new component types each render would remount every image.
  const components = useMemo(() => makeComponents(source, root), [source, root]);
  // Re-rendering the whole document per keystroke must not slow typing down.
  const deferred = useDeferredValue(text);

  if (error) return <div className="empty editor__error">{`Can't preview ${source}: ${error}`}</div>;

  return (
    <div className="md-preview">
      <article className="md-preview__body">
        <Markdown remarkPlugins={REMARK_PLUGINS} components={components}>
          {deferred}
        </Markdown>
      </article>
    </div>
  );
}
