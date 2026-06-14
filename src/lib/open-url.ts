import type { NotebookHost } from "@nteract/notebook-host";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

type ExternalLinkHost = Pick<NotebookHost, "externalLinks">;

let _host: ExternalLinkHost | null = null;

/**
 * Register the host instance for `openUrl`.
 *
 * This module-level hook keeps call sites (`openUrl(url)`) simple for shared
 * markdown/cell surfaces while each host owns the actual external-link policy.
 */
export function setOpenUrlHost(host: ExternalLinkHost | null): void {
  _host = host;
}

/**
 * Open a URL in the host's external browser/link handler.
 *
 * Only safe protocols are allowed because URLs may originate from untrusted
 * notebook content.
 */
export async function openUrl(url: string): Promise<void> {
  const normalized = url.trim();

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    console.error("openUrl: refusing to open invalid URL", { url: normalized });
    return;
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    console.error("openUrl: refusing to open URL with disallowed protocol", {
      url: normalized,
      protocol: parsed.protocol,
    });
    return;
  }

  if (!_host) {
    console.error("openUrl: host not initialized - dropping URL", {
      url: normalized,
    });
    return;
  }

  try {
    await _host.externalLinks.open(normalized);
  } catch (err) {
    console.error("openUrl: failed to open URL", {
      url: normalized,
      error: err,
    });
  }
}
