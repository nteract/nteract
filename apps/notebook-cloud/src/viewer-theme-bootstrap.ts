export const CLOUD_VIEWER_THEME_STORAGE_KEY = "nteract.cloud.viewer.theme";

export function viewerThemeFirstPaintStyle(): string {
  return `html {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  background: var(--background);
  color-scheme: light;
}

html.light,
html[data-theme="light"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  background: var(--background);
  color-scheme: light;
}

html.dark,
html[data-theme="dark"] {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  background: var(--background);
  color-scheme: dark;
}

body,
#root {
  min-height: 100%;
  margin: 0;
  background: var(--background);
  color: var(--foreground);
}`;
}

export function viewerThemeBootstrapScript(): string {
  return `(() => {
  let stored;
  try {
    stored = window.localStorage?.getItem(${JSON.stringify(CLOUD_VIEWER_THEME_STORAGE_KEY)});
  } catch {}
  const theme = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const resolved = theme === "system" ? (prefersDark ? "dark" : "light") : theme;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
})();`;
}
