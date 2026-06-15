export type CloudMarkdownDocumentScope = "owner" | "editor" | "viewer";

export interface CloudMarkdownDocumentListItem {
  document_id: string;
  title: string | null;
  owner_principal: string;
  body_doc_id: string;
  scope: CloudMarkdownDocumentScope;
  created_at: string;
  updated_at: string;
  latest_revision_id: string | null;
  viewer_url: string;
  endpoints: {
    catalog: string;
  };
}

export function cloudMarkdownDocumentDisplayTitle(document: CloudMarkdownDocumentListItem): string {
  return document.title?.trim() || "Untitled Markdown";
}

export function cloudMarkdownDocumentOpenUrl(
  document: CloudMarkdownDocumentListItem,
  options: { browserOrigin?: string | null } = {},
): string {
  return cloudMarkdownDocumentUrlOnCurrentOrigin(document.viewer_url, options);
}

export function cloudMarkdownDocumentUrlOnCurrentOrigin(
  value: string,
  options: { browserOrigin?: string | null } = {},
): string {
  const browserOrigin = options.browserOrigin ?? currentBrowserOrigin();
  const url = new URL(value, browserOrigin ?? undefined);
  if (
    browserOrigin &&
    (url.origin === browserOrigin || isHostedMarkdownDocumentPath(url.pathname))
  ) {
    return `${url.pathname}${url.search}${url.hash}`;
  }
  return value;
}

function currentBrowserOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

function isHostedMarkdownDocumentPath(pathname: string): boolean {
  return /^\/m\/[^/]+(?:\/.*)?\/?$/.test(pathname);
}

export function isCloudMarkdownDocumentListItem(
  value: unknown,
): value is CloudMarkdownDocumentListItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CloudMarkdownDocumentListItem>;
  return (
    typeof candidate.document_id === "string" &&
    (candidate.title === null || typeof candidate.title === "string") &&
    typeof candidate.owner_principal === "string" &&
    typeof candidate.body_doc_id === "string" &&
    isCloudMarkdownDocumentScope(candidate.scope) &&
    typeof candidate.created_at === "string" &&
    typeof candidate.updated_at === "string" &&
    (candidate.latest_revision_id === null || typeof candidate.latest_revision_id === "string") &&
    typeof candidate.viewer_url === "string" &&
    Boolean(candidate.endpoints) &&
    typeof candidate.endpoints?.catalog === "string"
  );
}

function isCloudMarkdownDocumentScope(value: unknown): value is CloudMarkdownDocumentScope {
  return value === "owner" || value === "editor" || value === "viewer";
}
