import { useEffect, useMemo, useState, type FormEvent } from "react";
import { BookOpen, FileText, Loader2, Plus, RotateCcw } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import {
  clearCloudPrototypeDevAuth,
  fetchWithCloudPrototypeAuth,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { clearCloudAppSession, establishCloudAppSession } from "./app-session";
import { CloudNotebookSignInButton } from "./cloud-auth-controls";
import { cloudResponseError } from "./cloud-response";
import { loadCloudMarkdownDocumentListBootstrap } from "./cloud-viewer-config";
import {
  cloudMarkdownDocumentDisplayTitle,
  cloudMarkdownDocumentOpenUrl,
  cloudMarkdownDocumentUrlOnCurrentOrigin,
  isCloudMarkdownDocumentListItem,
  type CloudMarkdownDocumentListItem,
} from "./markdown-document-dashboard";
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
    initialMarkdownDocumentListState(bootstrap),
  );
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState(() => defaultMarkdownDocumentTitle());
  const [createState, setCreateState] = useState<"idle" | "starting">("idle");
  const [createError, setCreateError] = useState<string | null>(null);
  const hasExplicitAuth = authState.mode === "dev" || authState.mode === "oidc";
  const hasAppSession = Boolean(appSessionStatus.session);
  const signedIn = hasExplicitAuth || hasAppSession;
  const canFetchDocumentList = authState.mode === "dev" || hasAppSession;
  const waitingForAppSession = authState.mode === "oidc" && !hasAppSession;
  const documents = listState.kind === "ready" ? listState.documents : [];

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (!canFetchDocumentList) {
      if (waitingForAppSession && bootstrap) {
        setListState({ kind: "ready", documents: bootstrap.documents });
        return;
      }
      setListState({ kind: "signed_out" });
      return;
    }
    if (refreshIndex === 0 && bootstrap) {
      setListState({ kind: "ready", documents: bootstrap.documents });
      return;
    }

    const controller = new AbortController();
    setListState(
      bootstrap ? { kind: "ready", documents: bootstrap.documents } : { kind: "loading" },
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
  }, [authState, bootstrap, canFetchDocumentList, refreshIndex, waitingForAppSession]);

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
      window.location.assign(cloudMarkdownDocumentUrlOnCurrentOrigin(body.viewer_url));
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
    <main className="cloud-dashboard-shell">
      <header className="cloud-dashboard-header">
        <div>
          <p className="cloud-dashboard-eyebrow">Markdown</p>
          <h1>Documents</h1>
          <p>
            {signedIn
              ? "Draft, review, and publish Markdown without compute."
              : "Sign in to open Markdown documents."}
          </p>
        </div>
        <div className="cloud-dashboard-actions">
          <a className="cloud-dashboard-button" href="/n">
            <BookOpen aria-hidden="true" />
            Notebooks
          </a>
          <CloudNotebookSignInButton
            authConfig={authConfig}
            authState={authState}
            documentLabel="document"
          />
          {signedIn ? (
            <>
              <button type="button" className="cloud-dashboard-button" onClick={refreshList}>
                <RotateCcw aria-hidden="true" />
                Refresh
              </button>
              <button
                type="button"
                className="cloud-dashboard-button"
                onClick={() => setCreateOpen(true)}
              >
                <Plus aria-hidden="true" />
                New Markdown
              </button>
            </>
          ) : null}
        </div>
      </header>

      {createOpen ? (
        <form className="cloud-dashboard-create" onSubmit={createDocument}>
          <label>
            <span>Title</span>
            <input
              value={createTitle}
              onChange={(event) => setCreateTitle(event.target.value)}
              maxLength={160}
              autoFocus
            />
          </label>
          <div className="cloud-dashboard-create-actions">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              disabled={createState === "starting"}
            >
              Cancel
            </button>
            <button type="submit" disabled={createState === "starting"}>
              {createState === "starting" ? (
                <Loader2 aria-hidden="true" />
              ) : (
                <Plus aria-hidden="true" />
              )}
              Create
            </button>
          </div>
          {createError ? (
            <p className="cloud-state" data-kind="error">
              {createError}
            </p>
          ) : null}
        </form>
      ) : null}

      <section className="cloud-document-list" aria-label="Markdown documents">
        {listState.kind === "loading" ? (
          <div className="cloud-state" data-kind="loading">
            <Loader2 aria-hidden="true" />
            Loading Markdown documents
          </div>
        ) : null}
        {listState.kind === "signed_out" ? (
          <div className="cloud-state" data-kind="empty">
            Sign in to see Markdown documents.
          </div>
        ) : null}
        {listState.kind === "error" ? (
          <div className="cloud-state" data-kind="error">
            {listState.message}
          </div>
        ) : null}
        {listState.kind === "ready" && sortedDocuments.length === 0 ? (
          <div className="cloud-state" data-kind="empty">
            No Markdown documents yet.
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

      {signedIn ? (
        <button
          type="button"
          className="cloud-dashboard-secondary-action"
          onClick={() => {
            clearCloudPrototypeDevAuth(window.localStorage);
            void clearCloudAppSession().finally(() => {
              window.location.reload();
            });
          }}
        >
          Sign out
        </button>
      ) : null}
    </main>
  );
}

function initialMarkdownDocumentListState(
  bootstrap: CloudMarkdownDocumentListBootstrap | null,
): MarkdownDocumentListState {
  return bootstrap ? { kind: "ready", documents: bootstrap.documents } : { kind: "loading" };
}

function fetchMarkdownDocumentList(
  authState: CloudPrototypeAuthState,
  signal: AbortSignal,
): Promise<Response> {
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
