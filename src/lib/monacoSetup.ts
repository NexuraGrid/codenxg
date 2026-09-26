import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { emmetCSS, emmetHTML } from "emmet-monaco-es";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { registerSemanticHighlighting } from "./semanticHighlight";
import { applyEditorTheme, registerGoTokenizer } from "./editorTheme";

// Without this, @monaco-editor/react downloads its own Monaco from a CDN.
// monacoModelRegistry creates models with the bundled npm instance, and an
// editor from one instance cannot display a model from the other — files
// opened as tabs but rendered blank.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });

// Global, once: both the code editor and the diff view use them, and either
// can be the first to mount.
applyEditorTheme(monaco);
registerGoTokenizer(monaco);
registerSemanticHighlighting(monaco);

// VS Code's Emmet: "!" + Tab for an HTML5 skeleton, "ul>li*3", "m10" in CSS.
// PHP files are HTML at the top level, like in VS Code.
emmetHTML(monaco, ["html", "php"]);
emmetCSS(monaco, ["css", "scss", "less"]);
