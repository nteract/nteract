import { FRAME_HTML } from "./frame-html";

/**
 * Physical frame resource used by the Tauri app.
 *
 * Browser-only development uses srcDoc so local Vite can serve the parent app
 * without also registering the custom scheme.
 */
export const NTERACT_FRAME_URL = "nteract-frame://localhost/";

/**
 * Sandbox attributes for the isolated iframe.
 *
 * CRITICAL: Do NOT include 'allow-same-origin' - this would give the iframe
 * access to the parent's origin and Tauri APIs.
 */
export const ISOLATED_FRAME_SANDBOX_ATTRS = [
  "allow-scripts", // Required for rendering interactive content
  "allow-downloads", // Allow file downloads (e.g., from widgets)
  "allow-forms", // Allow form submissions
  "allow-pointer-lock", // For interactive visualizations
  // Fullscreen for sift maximize, maps, 3D, etc. is enabled via the iframe
  // `allow` policy below, not as a sandbox flag.
].join(" ");

export const ISOLATED_FRAME_ALLOW_ATTR = "fullscreen *";

export type IsolatedFrameDocument = { kind: "src"; url: string } | { kind: "srcdoc"; html: string };

export interface IsolatedFrameThemeSeed {
  theme?: "light" | "dark" | null;
  colorTheme?: string | null;
}

export interface TauriFrameGlobal {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
}

export function isTauriFrameRuntime(
  globalWindow: TauriFrameGlobal | undefined = typeof window === "undefined"
    ? undefined
    : (window as Window & TauriFrameGlobal),
): boolean {
  return Boolean(
    globalWindow && ("__TAURI_INTERNALS__" in globalWindow || "__TAURI__" in globalWindow),
  );
}

export function createIsolatedFrameDocument(options?: {
  isTauriRuntime?: boolean;
  outputDocumentUrl?: string | null;
  themeSeed?: IsolatedFrameThemeSeed;
}): IsolatedFrameDocument {
  const outputDocumentUrl = options?.outputDocumentUrl?.trim();
  if (outputDocumentUrl) {
    return { kind: "src", url: withIsolatedFrameThemeSeed(outputDocumentUrl, options?.themeSeed) };
  }

  if (options?.isTauriRuntime ?? isTauriFrameRuntime()) {
    return { kind: "src", url: NTERACT_FRAME_URL };
  }
  return { kind: "srcdoc", html: FRAME_HTML };
}

function withIsolatedFrameThemeSeed(
  outputDocumentUrl: string,
  themeSeed: IsolatedFrameThemeSeed | undefined,
): string {
  if (!themeSeed?.theme && !themeSeed?.colorTheme) {
    return outputDocumentUrl;
  }

  try {
    const isAbsoluteOrProtocolRelative =
      /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(outputDocumentUrl) || outputDocumentUrl.startsWith("//");
    const parsed = new URL(outputDocumentUrl, "https://nteract.invalid");
    if (themeSeed.theme === "light" || themeSeed.theme === "dark") {
      parsed.searchParams.set("nteract_theme", themeSeed.theme);
    }
    if (themeSeed.colorTheme && themeSeed.colorTheme !== "classic") {
      parsed.searchParams.set("nteract_color_theme", themeSeed.colorTheme);
    }

    if (isAbsoluteOrProtocolRelative) {
      return parsed.href;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return outputDocumentUrl;
  }
}
