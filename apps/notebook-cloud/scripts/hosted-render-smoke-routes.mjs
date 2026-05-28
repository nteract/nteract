export function renderApiUrlForViewer(viewerUrl, headsHash) {
  const parsed = notebookViewerUrl(viewerUrl);
  if (!parsed || typeof headsHash !== "string" || headsHash.length === 0) {
    return null;
  }
  return new URL(
    `/api/n/${parsed.notebookId}/renders/${encodeURIComponent(headsHash)}`,
    parsed.origin,
  ).href;
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
