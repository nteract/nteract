import { useSyncExternalStore } from "react";

export interface NotebookEditorSettings {
  codeFontFamily: string;
  markdownFontFamily: string;
  lineNumbers: boolean;
}

export const DEFAULT_NOTEBOOK_EDITOR_SETTINGS: NotebookEditorSettings = Object.freeze({
  codeFontFamily: "",
  markdownFontFamily: "",
  lineNumbers: false,
});

type HostEditorSettings = {
  code_font_family?: unknown;
  markdown_font_family?: unknown;
  line_numbers?: unknown;
};

const MAX_FONT_FAMILY_LENGTH = 240;

let snapshot: NotebookEditorSettings = DEFAULT_NOTEBOOK_EDITOR_SETTINGS;
const subscribers = new Set<() => void>();

function normalizeFontFamily(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const withoutControlChars = Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
  const [firstDeclaration] = withoutControlChars.split(/[;{}]/);
  return (firstDeclaration ?? "").trim().slice(0, MAX_FONT_FAMILY_LENGTH);
}

function normalizeEditorSettings(
  settings: Partial<NotebookEditorSettings>,
): NotebookEditorSettings {
  return {
    codeFontFamily: normalizeFontFamily(settings.codeFontFamily),
    markdownFontFamily: normalizeFontFamily(settings.markdownFontFamily),
    lineNumbers: settings.lineNumbers === true,
  };
}

function settingsEqual(a: NotebookEditorSettings, b: NotebookEditorSettings): boolean {
  return (
    a.codeFontFamily === b.codeFontFamily &&
    a.markdownFontFamily === b.markdownFontFamily &&
    a.lineNumbers === b.lineNumbers
  );
}

function applyEditorFontVariables(settings: NotebookEditorSettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  if (settings.codeFontFamily) {
    root.style.setProperty("--output-mono-font", settings.codeFontFamily);
  } else {
    root.style.removeProperty("--output-mono-font");
  }

  if (settings.markdownFontFamily) {
    root.style.setProperty("--output-document-font", settings.markdownFontFamily);
  } else {
    root.style.removeProperty("--output-document-font");
  }
}

function emitEditorSettingsChanged(): void {
  for (const subscriber of subscribers) subscriber();
}

export function projectNotebookEditorSettings(
  settings: unknown,
  fallback: NotebookEditorSettings = snapshot,
): NotebookEditorSettings {
  if (!settings || typeof settings !== "object") return fallback;
  const editor = settings as HostEditorSettings;
  return {
    codeFontFamily: normalizeFontFamily(editor.code_font_family, fallback.codeFontFamily),
    markdownFontFamily: normalizeFontFamily(
      editor.markdown_font_family,
      fallback.markdownFontFamily,
    ),
    lineNumbers:
      typeof editor.line_numbers === "boolean" ? editor.line_numbers : fallback.lineNumbers,
  };
}

export function getNotebookEditorSettingsSnapshot(): NotebookEditorSettings {
  return snapshot;
}

export function setNotebookEditorSettings(
  settings: Partial<NotebookEditorSettings>,
): NotebookEditorSettings {
  const next = normalizeEditorSettings({ ...snapshot, ...settings });
  if (settingsEqual(snapshot, next)) return snapshot;
  snapshot = next;
  applyEditorFontVariables(snapshot);
  emitEditorSettingsChanged();
  return snapshot;
}

export function updateNotebookEditorSettings(
  settings: Partial<NotebookEditorSettings>,
): NotebookEditorSettings {
  return setNotebookEditorSettings(settings);
}

function subscribeNotebookEditorSettings(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function useNotebookEditorSettings(): NotebookEditorSettings {
  return useSyncExternalStore(
    subscribeNotebookEditorSettings,
    getNotebookEditorSettingsSnapshot,
    getNotebookEditorSettingsSnapshot,
  );
}

export function editorFontFamilyForLanguage(
  language: string | undefined,
  settings: NotebookEditorSettings,
): string {
  if (language === "markdown" && settings.markdownFontFamily) {
    return settings.markdownFontFamily;
  }
  return settings.codeFontFamily;
}
