import { useDeferredValue, useEffect, useState, type ComponentProps, type MouseEvent } from "react";
import * as monaco from "monaco-editor";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getModel } from "../lib/monacoModelRegistry";
import { readFile } from "../lib/tauri-api";

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

// The CSP only lets the webview load its own and data:/blob: images, and the
// asset protocol is off, so images are shown as their alt text instead.
function Image({ alt, src }: ComponentProps<"img">) {
  return (
    <span className="md-preview__img" title={typeof src === "string" ? src : undefined}>
      [image{alt ? `: ${alt}` : ""}]
    </span>
  );
}

const COMPONENTS: Components = { code: Code, a: Link, img: Image };

export function MarkdownPreview({ source }: { source: string }) {
  const { text, error } = useMarkdownSource(source);
  // Re-rendering the whole document per keystroke must not slow typing down.
  const deferred = useDeferredValue(text);

  if (error) return <div className="empty editor__error">{`Can't preview ${source}: ${error}`}</div>;

  return (
    <div className="md-preview">
      <article className="md-preview__body">
        <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
          {deferred}
        </Markdown>
      </article>
    </div>
  );
}
