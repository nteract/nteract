import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertCircle, BookOpen, FileText, Loader2, LogOut, Plus, RotateCcw } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import {
  clearCloudPrototypeDevAuth,
  fetchWithCloudPrototypeAuth,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import {
  clearCloudAppSession,
  establishCloudAppSession,
  type CloudAppSession,
} from "./app-session";
import { CloudNotebookSignInButton } from "./cloud-auth-controls";
import { CloudHostedDocumentSignedOutPanel } from "./cloud-hosted-document-signed-out";
import { cloudResponseError } from "./cloud-response";
import { loadCloudMarkdownDocumentListBootstrap } from "./cloud-viewer-config";
import {
  cloudMarkdownDocumentDisplayTitle,
  cloudMarkdownDocumentOpenUrl,
  cloudMarkdownDocumentOpenUrlWithMode,
  isCloudMarkdownDocumentListItem,
  type CloudMarkdownDocumentListItem,
} from "./markdown-document-dashboard";
import { projectHostedDocumentAuthState } from "./hosted-document-auth";
import {
  clearCachedCloudMarkdownDocumentList,
  readCachedCloudMarkdownDocumentList,
  writeCachedCloudMarkdownDocumentList,
} from "./markdown-document-list-cache";
import type {
  CloudMarkdownDocumentCreateResponse,
  CloudMarkdownDocumentListBootstrap,
  CloudMarkdownDocumentListResponse,
  CloudViewerAuthConfig,
} from "./cloud-viewer-types";
import { applyDocumentTheme, CLOUD_VIEWER_THEME_STORAGE_KEY } from "./theme";
import {
  useCloudAppSessionBridge,
  useCloudAppSessionStatus,
  useCloudPrototypeAuth,
} from "./use-cloud-auth";

type MarkdownDocumentListState =
  | { kind: "loading" }
  | { kind: "ready"; documents: CloudMarkdownDocumentListItem[] }
  | { kind: "signed_out" }
  | { kind: "error"; message: string };

export function CloudMarkdownDocumentListView({
  authConfig,
}: {
  authConfig: CloudViewerAuthConfig;
}) {
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const [bootstrap, setBootstrap] = useState<CloudMarkdownDocumentListBootstrap | null>(() =>
    loadCloudMarkdownDocumentListBootstrap(),
  );
  const appSessionStatus = useCloudAppSessionStatus(bootstrap?.session ?? null);
  const { authState } = useCloudPrototypeAuth(authConfig, {
    appSessionRefreshFallback: true,
    appSessionLoading: appSessionStatus.status === "loading",
    appSession: appSessionStatus.session,
  });
  useCloudAppSessionBridge(
    authState,
    appSessionStatus.session,
    appSessionStatus.status === "loading",
    appSessionStatus.refreshAppSessionStatus,
  );
  const [listState, setListState] = useState<MarkdownDocumentListState>(() =>
    initialMarkdownDocumentListState(authState, bootstrap, appSessionStatus.session),
  );
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState(() => defaultMarkdownDocumentTitle());
  const [createState, setCreateState] = useState<"idle" | "starting">("idle");
  const [createError, setCreateError] = useState<string | null>(null);
  const hostedAuth = projectHostedDocumentAuthState(authState, {
    appSession: appSessionStatus.session,
    appSessionLoading: appSessionStatus.status === "loading",
  });
  const {
    canFetchCatalog: canFetchDocumentList,
    hasAppSession,
    showSignIn,
    signedIn,
    waitingForAppSession,
  } = hostedAuth;
  const documents = listState.kind === "ready" ? listState.documents : [];

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    document.title = "nteract Markdown documents";
  }, []);

  useEffect(() => {
    const seededDocuments = cloudMarkdownDocumentListSeedFromBootstrapOrCache(
      authState,
      bootstrap,
      appSessionStatus.session,
    );
    if (!canFetchDocumentList) {
      if (waitingForAppSession) {
        setListState(
          seededDocuments ? { kind: "ready", documents: seededDocuments } : { kind: "loading" },
        );
        return;
      }
      clearCachedCloudMarkdownDocumentListFromWindow();
      setListState({ kind: "signed_out" });
      return;
    }
    if (refreshIndex === 0 && bootstrap) {
      writeCachedCloudMarkdownDocumentListToWindow(
        authState,
        appSessionStatus.session,
        bootstrap.documents,
      );
      setListState({ kind: "ready", documents: bootstrap.documents });
      return;
    }

    const controller = new AbortController();
    setListState(
      seededDocuments ? { kind: "ready", documents: seededDocuments } : { kind: "loading" },
    );
    void (async () => {
      try {
        const response = await fetchMarkdownDocumentList(authState, controller.signal);
        if (controller.signal.aborted) return;
        if (!response.ok) {
          throw await cloudResponseError(response, "Unable to list Markdown documents");
        }
        const body = (await response.json()) as unknown;
        if (!isCloudMarkdownDocumentListResponse(body)) {
          throw new Error("Unable to list Markdown documents: response shape was invalid");
        }
        writeCachedCloudMarkdownDocumentListToWindow(
          authState,
          appSessionStatus.session,
          body.documents,
        );
        setListState({ kind: "ready", documents: body.documents });
        setBootstrap({
          kind: "markdown-document-list",
          documents: body.documents,
          saved_at: new Date().toISOString(),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setListState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => controller.abort();
  }, [
    appSessionStatus.session,
    authState,
    bootstrap,
    canFetchDocumentList,
    refreshIndex,
    waitingForAppSession,
  ]);

  const refreshList = () => {
    if (authState.mode === "oidc" && authState.token) {
      void establishCloudAppSession(authState)
        .catch((error: unknown) => {
          console.warn("[notebook-cloud] app session refresh before Markdown list failed", error);
        })
        .finally(() => {
          appSessionStatus.refreshAppSessionStatus();
          setRefreshIndex((value) => value + 1);
        });
      return;
    }
    setRefreshIndex((value) => value + 1);
  };

  const createDocument = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!signedIn || createState === "starting") {
      return;
    }
    const title = createTitle.trim() || defaultMarkdownDocumentTitle();
    try {
      setCreateError(null);
      setCreateState("starting");
      if (authState.mode === "oidc" && authState.token && !hasAppSession) {
        await establishCloudAppSession(authState);
        appSessionStatus.refreshAppSessionStatus();
      }
      const response = await fetchWithCloudPrototypeAuth(
        markdownDocumentCollectionEndpoint(),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title }),
        },
        cloudAuthWithScope(authState, "owner"),
      );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to create Markdown document");
      }
      const body = (await response.json()) as CloudMarkdownDocumentCreateResponse;
      if (body.ok !== true || typeof body.viewer_url !== "string") {
        throw new Error("Unable to create Markdown document: response shape was invalid");
      }
      window.location.assign(cloudMarkdownDocumentOpenUrlWithMode(body.viewer_url, "edit"));
    } catch (error) {
      setCreateState("idle");
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const sortedDocuments = useMemo(
    () =>
      [...documents].sort(
        (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at),
      ),
    [documents],
  );

  return (
    <main className="cloud-notebook-list-page cloud-markdown-list-page">
      <header className="cloud-notebook-list-header">
        <div>
          <a className="cloud-notebook-list-brand" href="/m">
            Markdown
          </a>
          <h1>Documents</h1>
          <p>
            {signedIn
              ? "Draft, review, and share Markdown without compute."
              : "Sign in to open Markdown documents."}
          </p>
        </div>
        <div className="cloud-notebook-list-actions">
          <a href="/n">
            <BookOpen aria-hidden="true" />
            Notebooks
          </a>
          {showSignIn ? (
            <CloudNotebookSignInButton
              authConfig={authConfig}
              authState={authState}
              documentLabel="document"
            />
          ) : null}
          {signedIn ? (
            <>
              <button type="button" onClick={refreshList}>
                <RotateCcw aria-hidden="true" />
                Refresh
              </button>
              <button type="button" onClick={() => setCreateOpen(true)}>
                <Plus aria-hidden="true" />
                New Markdown
              </button>
              <button
                type="button"
                onClick={() => {
                  clearCloudPrototypeDevAuth(window.localStorage);
                  clearCachedCloudMarkdownDocumentListFromWindow();
                  void clearCloudAppSession().finally(() => {
                    window.location.reload();
                  });
                }}
              >
                <LogOut aria-hidden="true" />
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>

      {createOpen ? (
        <>
          <form className="cloud-new-notebook-form" onSubmit={createDocument}>
            <label htmlFor="cloud-new-markdown-title">Document title</label>
            <input
              id="cloud-new-markdown-title"
              value={createTitle}
              onChange={(event) => setCreateTitle(event.target.value)}
              maxLength={160}
              autoFocus
            />
            <button type="submit" disabled={createState === "starting"}>
              {createState === "starting" ? (
                <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
              ) : (
                <Plus aria-hidden="true" />
              )}
              Create
            </button>
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              disabled={createState === "starting"}
            >
              Cancel
            </button>
          </form>
          {createError ? (
            <div className="cloud-notebook-list-banner" data-kind="error" role="alert">
              {createError}
            </div>
          ) : null}
        </>
      ) : null}

      <section
        className="cloud-notebook-list-content cloud-document-list"
        aria-label="Markdown documents"
      >
        {listState.kind === "loading" ? (
          <div className="cloud-notebook-list-state" data-kind="loading" role="status">
            <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
            <span>Loading Markdown documents</span>
          </div>
        ) : null}
        {listState.kind === "signed_out" ? (
          <CloudHostedDocumentSignedOutPanel
            authConfig={authConfig}
            authState={authState}
            cloudTitle="Write live Markdown."
            cloudDescription="Sign in to create realtime Markdown documents, review drafts, and share work."
            localTitle="Open local Markdown."
            localDescription="Use local auth to create Markdown documents and test the live editor on this machine."
          />
        ) : null}
        {listState.kind === "error" ? (
          <div className="cloud-notebook-list-state" data-kind="error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{listState.message}</span>
          </div>
        ) : null}
        {listState.kind === "ready" && sortedDocuments.length === 0 ? (
          <div className="cloud-notebook-list-state" data-kind="empty">
            <FileText aria-hidden="true" />
            <span>No Markdown documents yet.</span>
          </div>
        ) : null}
        {sortedDocuments.map((document) => (
          <a
            key={document.document_id}
            className="cloud-document-row"
            href={cloudMarkdownDocumentOpenUrl(document)}
          >
            <FileText aria-hidden="true" />
            <span>
              <strong>{cloudMarkdownDocumentDisplayTitle(document)}</strong>
              <small>
                {document.scope} · updated {formatShortDate(document.updated_at)}
              </small>
            </span>
          </a>
        ))}
      </section>
    </main>
  );
}

function initialMarkdownDocumentListState(
  authState: CloudPrototypeAuthState,
  bootstrap: CloudMarkdownDocumentListBootstrap | null,
  appSession: CloudAppSession | null,
): MarkdownDocumentListState {
  const seededDocuments = cloudMarkdownDocumentListSeedFromBootstrapOrCache(
    authState,
    bootstrap,
    appSession,
  );
  return seededDocuments ? { kind: "ready", documents: seededDocuments } : { kind: "loading" };
}

function fetchMarkdownDocumentList(
  authState: CloudPrototypeAuthState,
  signal: AbortSignal,
): Promise<Response> {
  if (authState.mode !== "dev" && authState.mode !== "oidc") {
    return fetch(markdownDocumentListEndpoint(), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    });
  }
  return fetchWithCloudPrototypeAuth(
    markdownDocumentListEndpoint(),
    { headers: { Accept: "application/json" }, signal },
    cloudAuthWithScope(authState, "viewer"),
  );
}

function markdownDocumentListEndpoint(): string {
  return new URL("api/m?limit=100", `${window.location.origin}/`).href;
}

function markdownDocumentCollectionEndpoint(): string {
  return new URL("api/m", `${window.location.origin}/`).href;
}

function cloudAuthWithScope(
  authState: CloudPrototypeAuthState,
  scope: "viewer" | "editor" | "owner",
): CloudPrototypeAuthState {
  return authState.mode === "dev" ? { ...authState, requestedScope: scope } : authState;
}

function cloudMarkdownDocumentListSeedFromBootstrapOrCache(
  authState: CloudPrototypeAuthState,
  bootstrap: CloudMarkdownDocumentListBootstrap | null,
  appSession: CloudAppSession | null,
): CloudMarkdownDocumentListItem[] | null {
  return (
    bootstrap?.documents ?? readCachedCloudMarkdownDocumentListFromWindow(authState, appSession)
  );
}

function readCachedCloudMarkdownDocumentListFromWindow(
  authState: CloudPrototypeAuthState,
  appSession: CloudAppSession | null,
): CloudMarkdownDocumentListItem[] | null {
  const storage = cloudMarkdownDocumentListCacheStorage();
  return storage ? readCachedCloudMarkdownDocumentList(storage, authState, appSession) : null;
}

function writeCachedCloudMarkdownDocumentListToWindow(
  authState: CloudPrototypeAuthState,
  appSession: CloudAppSession | null,
  documents: CloudMarkdownDocumentListItem[],
): void {
  const storage = cloudMarkdownDocumentListCacheStorage();
  if (!storage) {
    return;
  }
  writeCachedCloudMarkdownDocumentList(storage, authState, appSession, documents);
}

function clearCachedCloudMarkdownDocumentListFromWindow(): void {
  const storage = cloudMarkdownDocumentListCacheStorage();
  if (!storage) {
    return;
  }
  clearCachedCloudMarkdownDocumentList(storage);
}

function cloudMarkdownDocumentListCacheStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function defaultMarkdownDocumentTitle(): string {
  return `Markdown ${new Date().toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isCloudMarkdownDocumentListResponse(
  value: unknown,
): value is CloudMarkdownDocumentListResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CloudMarkdownDocumentListResponse>;
  return (
    candidate.ok === true &&
    Array.isArray(candidate.documents) &&
    candidate.documents.every(isCloudMarkdownDocumentListItem)
  );
}
