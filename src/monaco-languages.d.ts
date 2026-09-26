// Monaco ships its Monarch grammars without type declarations.
declare module "monaco-editor/languages/definitions/*" {
  import type { languages } from "monaco-editor";
  export const language: languages.IMonarchLanguage;
  export const conf: languages.LanguageConfiguration;
}
