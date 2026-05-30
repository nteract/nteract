export const ISOLATED_FRAME_SANDBOX_ATTRS = [
  "allow-scripts",
  "allow-downloads",
  "allow-forms",
  "allow-pointer-lock",
].join(" ");

export const ISOLATED_FRAME_ALLOW_ATTR = "fullscreen *";

export type IsolatedFrameDocument = { kind: "src"; url: string } | { kind: "srcdoc"; html: string };

interface IsolatedFrameThemeSeed {
  theme?: "light" | "dark" | null;
  colorTheme?: string | null;
}

const NTERACT_FRAME_URL = "nteract-frame://localhost/";
const FRAME_HTML_STUB = '<!doctype html><html><body><div id="root"></div></body></html>';

export function createIsolatedFrameDocument(options?: {
  isTauriRuntime?: boolean;
  outputDocumentUrl?: string | null;
  themeSeed?: IsolatedFrameThemeSeed;
}): IsolatedFrameDocument {
  const outputDocumentUrl = options?.outputDocumentUrl?.trim();
  if (outputDocumentUrl) {
    return { kind: "src", url: withIsolatedFrameThemeSeed(outputDocumentUrl, options?.themeSeed) };
  }

  if (options?.isTauriRuntime) {
    return { kind: "src", url: NTERACT_FRAME_URL };
  }
  return { kind: "srcdoc", html: FRAME_HTML_STUB };
}

function withIsolatedFrameThemeSeed(
  outputDocumentUrl: string,
  themeSeed: IsolatedFrameThemeSeed | undefined,
): string {
  if (!themeSeed?.theme && !themeSeed?.colorTheme) return outputDocumentUrl;

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

    if (isAbsoluteOrProtocolRelative) return parsed.href;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return outputDocumentUrl;
  }
}
