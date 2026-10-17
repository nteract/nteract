import { isSafeExternalUrl } from "../../../src/lib/open-url";
export function resolvePageLink(value: string, base: string): string | null {
  try {
    const url = new URL(value.trim(), base);
    return isSafeExternalUrl(url.href) ? url.href : null;
  } catch {
    return null;
  }
}
export function openPageLink(value: string): void {
  const href = resolvePageLink(value, location.href);
  if (!href) return;
  const url = new URL(href),
    current = new URL(location.href);
  if (
    url.origin === current.origin &&
    url.pathname === current.pathname &&
    url.search === current.search &&
    url.hash
  )
    location.hash = url.hash;
  else window.open(href, "_blank", "noopener,noreferrer");
}
