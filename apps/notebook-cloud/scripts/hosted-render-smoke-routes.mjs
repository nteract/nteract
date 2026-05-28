export function renderApiUrlForViewer(viewerUrl) {
  const parsed = notebookViewerUrl(viewerUrl);
  if (!parsed) {
    return null;
  }
  return new URL(`/api/n/${parsed.notebookId}/render`, parsed.origin).href;
}

export function catalogApiUrlForViewer(viewerUrl) {
  const parsed = notebookViewerUrl(viewerUrl);
  if (!parsed) {
    return null;
  }
  return new URL(`/api/n/${parsed.notebookId}`, parsed.origin).href;
}

export function notebookViewerUrl(viewerUrl) {
  const parsed = new URL(viewerUrl);
  const match = parsed.pathname.match(/^\/n\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!match) {
    return null;
  }
  const [, notebookId, vanityName] = match;
  if (vanityName && ["debug", "r", "sync"].includes(vanityName)) {
    return null;
  }
  return { origin: parsed.origin, notebookId, vanityName: vanityName ?? null };
}
