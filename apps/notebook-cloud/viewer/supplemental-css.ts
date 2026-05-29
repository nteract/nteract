const VIEWER_CSS_MANIFEST_PATH = "/assets/notebook-cloud-viewer-css.json";

let supplementalCssLoadStarted = false;

interface ViewerCssManifest {
  supplemental?: unknown;
}

export function supplementalStylesheetsFromManifest(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object") return [];

  const { supplemental } = manifest as ViewerCssManifest;
  if (!Array.isArray(supplemental)) return [];

  return supplemental.filter(isSafeViewerStylesheet);
}

export function loadSupplementalViewerCss(): void {
  if (typeof document === "undefined" || typeof fetch === "undefined") return;
  if (supplementalCssLoadStarted) return;
  supplementalCssLoadStarted = true;

  const load = () => {
    void fetch(VIEWER_CSS_MANIFEST_PATH, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((manifest) => {
        for (const href of supplementalStylesheetsFromManifest(manifest)) {
          appendStylesheetOnce(href);
        }
      })
      .catch(() => {
        // Supplemental CSS only affects lazy output surfaces. Missing manifests
        // should not block the notebook shell from rendering.
      });
  };

  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    window.requestIdleCallback(load, { timeout: 1000 });
    return;
  }

  setTimeout(load, 0);
}

function appendStylesheetOnce(href: string): void {
  for (const link of Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  )) {
    if (link.getAttribute("href") === href) return;
  }

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.nteractCloudSupplementalCss = "true";
  document.head.appendChild(link);
}

function isSafeViewerStylesheet(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/assets/") &&
    value.endsWith(".css") &&
    !value.includes("..") &&
    !value.includes("%")
  );
}
