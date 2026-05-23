export function renderApiUrlForViewer(viewerUrl) {
  const parsed = new URL(viewerUrl);
  const match = parsed.pathname.match(/^\/n\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }
  return new URL(`/api/n/${match[1]}/render`, parsed.origin).href;
}

export function catalogApiUrlForViewer(viewerUrl) {
  const parsed = new URL(viewerUrl);
  const match = parsed.pathname.match(/^\/n\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }
  return new URL(`/api/n/${match[1]}`, parsed.origin).href;
}
