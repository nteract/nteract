export function renderApiUrlForViewer(viewerUrl, headsHash) {
  const pinned = pinnedNotebookViewerUrl(viewerUrl);
  if (pinned) {
    return new URL(
      `/api/n/${encodeURIComponent(pinned.notebookId)}/renders/${encodeURIComponent(pinned.headsHash)}`,
      pinned.origin,
    ).href;
  }

  const parsed = notebookViewerUrl(viewerUrl);
  if (!parsed || typeof headsHash !== "string" || headsHash.length === 0) {
    return null;
  }
  return new URL(
    `/api/n/${encodeURIComponent(parsed.notebookId)}/renders/${encodeURIComponent(headsHash)}`,
    parsed.origin,
  ).href;
}

export function hostedNotebookRequestKind(viewerUrl, requestUrl) {
  const target = notebookViewerUrl(viewerUrl) ?? pinnedNotebookViewerUrl(viewerUrl);
  if (!target) {
    return null;
  }

  const parsedRequest = new URL(requestUrl);
  if (!sameHostedOrigin(parsedRequest, target.origin)) {
    return null;
  }

  const liveSyncMatch = parsedRequest.pathname.match(/^\/n\/([^/]+)\/sync\/?$/);
  if (liveSyncMatch && decodeURIComponent(liveSyncMatch[1]) === target.notebookId) {
    return { kind: "live-sync" };
  }

  const catalogMatch = parsedRequest.pathname.match(/^\/api\/n\/([^/]+)\/?$/);
  if (catalogMatch && decodeURIComponent(catalogMatch[1]) === target.notebookId) {
    return { kind: "catalog" };
  }

  const renderMatch = parsedRequest.pathname.match(/^\/api\/n\/([^/]+)\/renders\/([^/]+)$/);
  if (renderMatch && decodeURIComponent(renderMatch[1]) === target.notebookId) {
    return { kind: "render-cache", headsHash: decodeURIComponent(renderMatch[2]) };
  }

  const legacyRenderMatch = parsedRequest.pathname.match(/^\/api\/n\/([^/]+)\/render\/?$/);
  if (legacyRenderMatch && decodeURIComponent(legacyRenderMatch[1]) === target.notebookId) {
    return { kind: "legacy-render" };
  }

  return null;
}

function sameHostedOrigin(parsedRequest, targetOrigin) {
  const target = new URL(targetOrigin);
  const requestProtocol =
    parsedRequest.protocol === "wss:"
      ? "https:"
      : parsedRequest.protocol === "ws:"
        ? "http:"
        : parsedRequest.protocol;

  return (
    parsedRequest.hostname === target.hostname &&
    parsedRequest.port === target.port &&
    requestProtocol === target.protocol
  );
}

export function catalogApiUrlForViewer(viewerUrl) {
  const parsed = notebookViewerUrl(viewerUrl) ?? pinnedNotebookViewerUrl(viewerUrl);
  if (!parsed) {
    return null;
  }
  return new URL(`/api/n/${encodeURIComponent(parsed.notebookId)}`, parsed.origin).href;
}

export function expectedRenderSourceForViewer(viewerUrl, envValue) {
  if (envValue !== undefined) {
    const trimmed = envValue.trim();
    return trimmed ? trimmed : null;
  }
  return pinnedNotebookViewerUrl(viewerUrl) ? "snapshot-pair" : null;
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
  return {
    origin: parsed.origin,
    notebookId: decodeURIComponent(notebookId),
    vanityName: vanityName ? decodeURIComponent(vanityName) : null,
  };
}

export function pinnedNotebookViewerUrl(viewerUrl) {
  const parsed = new URL(viewerUrl);
  const match = parsed.pathname.match(/^\/n\/([^/]+)\/r\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }
  const [, notebookId, headsHash] = match;
  return {
    origin: parsed.origin,
    notebookId: decodeURIComponent(notebookId),
    headsHash: decodeURIComponent(headsHash),
  };
}
