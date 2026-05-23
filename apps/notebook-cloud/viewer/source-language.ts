import { languageDisplayNames, type SupportedLanguage } from "@/components/editor/languages";

const languageAliases: Record<string, SupportedLanguage> = {
  ipython: "ipython",
  py: "ipython",
  python: "ipython",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  html: "html",
  htm: "html",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  ts: "typescript",
  typescript: "typescript",
  tsx: "typescript",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  plain: "plain",
  text: "plain",
};

export function cloudSourceLanguage(language: string | null | undefined): SupportedLanguage {
  const normalized = normalizeLanguageId(language);
  if (!normalized) return "plain";

  const alias = languageAliases[normalized];
  if (alias) return alias;

  if (Object.prototype.hasOwnProperty.call(languageDisplayNames, normalized)) {
    return normalized as SupportedLanguage;
  }

  return "plain";
}

function normalizeLanguageId(language: string | null | undefined): string {
  return (language ?? "").trim().replace(/^\./, "").toLowerCase();
}
