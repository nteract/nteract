import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  BookOpen,
  FileText,
  FilePlus2,
  Loader2,
  LogOut,
  RotateCcw,
} from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import {
  clearCloudPrototypeDevAuth,
  fetchWithCloudPrototypeAuth,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { cloudResponseError } from "./cloud-response";
import {
  clearCloudAppSession,
  establishCloudAppSession,
  type CloudAppSession,
} from "./app-session";
import { CloudNotebookDashboard } from "./cloud-notebook-dashboard-view";
import { loadCloudNotebookListBootstrap } from "./cloud-viewer-config";
import type {
  CloudNotebookCreateResponse,
  CloudNotebookListBootstrap,
  CloudNotebookListResponse,
  CloudNotebookListState,
  CloudNotebookRenameState,
  CloudNotebookUpdateResponse,
  CloudViewerAuthConfig,
} from "./cloud-viewer-types";
import {
  cloudNotebookOpenUrlWithMode,
  projectCloudNotebookDashboard,
  type CloudNotebookListItem,
} from "./notebook-dashboard";
import { projectHostedDocumentAuthState } from "./hosted-document-auth";
import {
  clearCachedCloudNotebookList,
  readCachedCloudNotebookList,
  writeCachedCloudNotebookList,
} from "./notebook-list-cache";
import { applyDocumentTheme, CLOUD_VIEWER_THEME_STORAGE_KEY } from "./theme";
import {
  useCloudAppSessionBridge,
  useCloudAppSessionStatus,
  useCloudPrototypeAuth,
} from "./use-cloud-auth";
import { preloadNotebookRoute, scheduleNotebookRoutePreload } from "./notebook-route-preload";
import { CloudHostedDocumentSignedOutPanel } from "./cloud-hosted-document-signed-out";

export function CloudNotebookListView({ authConfig }: { authConfig: CloudViewerAuthConfig }) {
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const [bootstrap, setBootstrap] = useState<CloudNotebookListBootstrap | null>(() =>
    loadCloudNotebookListBootstrap(),
  );
  const appSessionStatus = useCloudAppSessionStatus(bootstrap?.session ?? null);
  const { authState, authRenewal, refreshAuthState } = useCloudPrototypeAuth(authConfig, {
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
  const [listState, setListState] = useState<CloudNotebookListState>(() =>
    initialCloudNotebookListState(authState, bootstrap, appSessionStatus.session),
  );
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [createState, setCreateState] = useState<"idle" | "starting">("idle");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState(() => defaultCloudNotebookTitle());
  const [renameState, setRenameState] = useState<CloudNotebookRenameState | null>(null);
  const [renameSavingId, setRenameSavingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const hostedAuth = projectHostedDocumentAuthState(authState, {
    appSession: appSessionStatus.session,
    appSessionLoading: appSessionStatus.status === "loading",
  });
  const {
    canFetchCatalog: canFetchNotebookList,
    hasAppSession,
    signedIn,
    waitingForAppSession,
  } = hostedAuth;
  const dashboardModel = useMemo(
    () => (listState.kind === "ready" ? projectCloudNotebookDashboard(listState.notebooks) : null),
    [listState],
  );

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    document.title = "nteract cloud notebooks";
  }, []);

  useEffect(() => {
    if (listState.kind === "ready" && listState.notebooks.length > 0) {
      scheduleNotebookRoutePreload();
    }
  }, [listState]);

  useEffect(() => {
    const seededNotebooks = cloudNotebookListSeedFromBootstrapOrCache(
      authState,
      bootstrap,
      appSessionStatus.session,
    );
    if (!canFetchNotebookList) {
      if (waitingForAppSession) {
        setListState(
          seededNotebooks ? { kind: "ready", notebooks: seededNotebooks } : { kind: "loading" },
        );
        return;
      }
      clearCachedCloudNotebookListFromWindow();
      setListState({ kind: "signed_out" });
      return;
    }

    if (refreshIndex === 0 && bootstrap) {
      writeCachedCloudNotebookListToWindow(
        authState,
        appSessionStatus.session,
        bootstrap.notebooks,
      );
      setListState({ kind: "ready", notebooks: bootstrap.notebooks });
      return;
    }

    const controller = new AbortController();
    setListState(
      seededNotebooks ? { kind: "ready", notebooks: seededNotebooks } : { kind: "loading" },
    );
    void (async () => {
      try {
        const response = await fetchCloudNotebookList(authState, controller.signal);
        if (controller.signal.aborted) return;
        if (!response.ok) {
          throw await cloudResponseError(response, "Unable to list notebooks");
        }
        const body = (await response.json()) as unknown;
        if (!isCloudNotebookListResponse(body)) {
          throw new Error("Unable to list notebooks: response shape was invalid");
        }
        writeCachedCloudNotebookListToWindow(authState, appSessionStatus.session, body.notebooks);
        setListState({ kind: "ready", notebooks: body.notebooks });
      } catch (error) {
        if (controller.signal.aborted) return;
        setListState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [
    appSessionStatus.session,
    authState,
    bootstrap,
    canFetchNotebookList,
    refreshIndex,
    waitingForAppSession,
  ]);

  const refreshList = () => {
    if (authState.mode === "oidc" && authState.token) {
      void establishCloudAppSession(authState)
        .catch((error: unknown) => {
          console.warn("[notebook-cloud] app session refresh before notebook list failed", error);
        })
        .finally(() => {
          appSessionStatus.refreshAppSessionStatus();
          setRefreshIndex((value) => value + 1);
        });
      return;
    }
    setRefreshIndex((value) => value + 1);
  };

  const openCreateForm = () => {
    if (!signedIn) {
      return;
    }
    setCreateError(null);
    setCreateTitle(defaultCloudNotebookTitle());
    setCreateFormOpen(true);
  };

  const closeCreateForm = () => {
    if (createState === "starting") {
      return;
    }
    setCreateError(null);
    setCreateFormOpen(false);
  };

  const createNotebook = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!signedIn || createState === "starting") {
      return;
    }
    const title = createTitle.trim() || defaultCloudNotebookTitle();
    try {
      setCreateError(null);
      setCreateState("starting");
      const response = await fetchWithCloudPrototypeAuth(
        cloudNotebookCollectionEndpoint(),
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
        throw await cloudResponseError(response, "Unable to create notebook");
      }
      const body = (await response.json()) as CloudNotebookCreateResponse;
      if (body.ok !== true || typeof body.viewer_url !== "string") {
        throw new Error("Unable to create notebook: response shape was invalid");
      }
      window.location.assign(
        cloudNotebookOpenUrlWithMode(body.viewer_url, "edit", {
          browserOrigin: window.location.origin,
        }),
      );
    } catch (error) {
      setCreateState("idle");
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const openRenameForm = useCallback((notebook: CloudNotebookListItem) => {
    setRenameError(null);
    setRenameState({
      notebookId: notebook.notebook_id,
      title: notebook.title?.trim() ?? "",
    });
  }, []);

  const closeRenameForm = useCallback(() => {
    if (renameSavingId) {
      return;
    }
    setRenameError(null);
    setRenameState(null);
  }, [renameSavingId]);

  const saveNotebookTitle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!signedIn || !renameState || renameSavingId) {
      return;
    }

    const notebookId = renameState.notebookId;
    const nextTitle = renameState.title.trim();
    try {
      setRenameError(null);
      setRenameSavingId(notebookId);
      const response = await fetchWithCloudPrototypeAuth(
        cloudNotebookCatalogEndpoint(notebookId),
        {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: nextTitle || null }),
        },
        cloudAuthWithScope(authState, "editor"),
      );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to rename notebook");
      }
      const body = (await response.json()) as CloudNotebookUpdateResponse;
      if (body.ok !== true || body.notebook_id !== notebookId) {
        throw new Error("Unable to rename notebook: response shape was invalid");
      }
      setListState((current) => {
        if (current.kind !== "ready") {
          return current;
        }
        const notebooks = current.notebooks.map((notebook) =>
          notebook.notebook_id === notebookId
            ? {
                ...notebook,
                title: body.title ?? null,
                updated_at: body.updated_at ?? notebook.updated_at,
                viewer_url: body.viewer_url ?? notebook.viewer_url,
              }
            : notebook,
        );
        writeCachedCloudNotebookListToWindow(authState, appSessionStatus.session, notebooks);
        return {
          kind: "ready",
          notebooks,
        };
      });
      setRenameState(null);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setRenameSavingId(null);
    }
  };

  const signOut = () => {
    setBootstrap(null);
    appSessionStatus.clearAppSessionStatus();
    clearCachedCloudNotebookListFromWindow();
    void clearCloudAppSession()
      .catch((error: unknown) => {
        console.warn("[notebook-cloud] app session clear failed", error);
      })
      .finally(appSessionStatus.refreshAppSessionStatus);
    clearCloudPrototypeDevAuth(window.localStorage);
    refreshAuthState();
  };

  const headerDetail = cloudNotebookListHeaderDetail(authState, hasAppSession, authConfig);

  return (
    <main className="cloud-notebook-list-page">
      <header className="cloud-notebook-list-header">
        <div>
          <a className="cloud-notebook-list-brand" href="/n">
            nteract
          </a>
          <h1>Notebooks</h1>
          <p>{headerDetail}</p>
        </div>
        <div className="cloud-notebook-list-actions">
          <a href="/m">
            <FileText aria-hidden="true" />
            Markdown docs
          </a>
          {signedIn ? (
            <>
              <button type="button" disabled={listState.kind === "loading"} onClick={refreshList}>
                <RotateCcw aria-hidden="true" />
                Refresh
              </button>
              <button type="button" disabled={createState === "starting"} onClick={openCreateForm}>
                {createState === "starting" ? (
                  <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
                ) : (
                  <FilePlus2 aria-hidden="true" />
                )}
                {createState === "starting" ? "Creating" : "New notebook"}
              </button>
              <button type="button" onClick={signOut}>
                <LogOut aria-hidden="true" />
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>

      {authRenewal.kind !== "idle" && !hasAppSession ? (
        <div
          className="cloud-notebook-list-banner"
          data-kind={authRenewal.kind === "failed" ? "error" : "info"}
          role={authRenewal.kind === "failed" ? "alert" : "status"}
        >
          {authRenewal.message}
        </div>
      ) : null}
      {createError ? (
        <div className="cloud-notebook-list-banner" data-kind="error" role="alert">
          {createError}
        </div>
      ) : null}
      {renameError ? (
        <div className="cloud-notebook-list-banner" data-kind="error" role="alert">
          {renameError}
        </div>
      ) : null}
      {createFormOpen ? (
        <form className="cloud-new-notebook-form" onSubmit={createNotebook}>
          <label htmlFor="cloud-new-notebook-title">Notebook title</label>
          <input
            id="cloud-new-notebook-title"
            type="text"
            value={createTitle}
            maxLength={160}
            disabled={createState === "starting"}
            onChange={(event) => setCreateTitle(event.currentTarget.value)}
          />
          <button type="submit" disabled={createState === "starting"}>
            {createState === "starting" ? (
              <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
            ) : (
              <FilePlus2 aria-hidden="true" />
            )}
            Create
          </button>
          <button type="button" disabled={createState === "starting"} onClick={closeCreateForm}>
            Cancel
          </button>
        </form>
      ) : null}

      <section className="cloud-notebook-list-content" aria-label="Notebook list">
        {listState.kind === "loading" ? (
          <div className="cloud-notebook-list-state" data-kind="loading" role="status">
            <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
            <span>Loading notebooks</span>
          </div>
        ) : listState.kind === "signed_out" ? (
          <CloudHostedDocumentSignedOutPanel
            authConfig={authConfig}
            authState={authState}
            cloudTitle="Bring computation to life."
            cloudDescription="Sign in to create live notebooks, share work with colleagues, and attach compute."
            localTitle="Open local notebooks."
            localDescription="Use local auth to create notebooks and test the live room on this machine."
          />
        ) : listState.kind === "error" ? (
          <div className="cloud-notebook-list-state" data-kind="error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{listState.message}</span>
          </div>
        ) : listState.notebooks.length === 0 ? (
          <div className="cloud-notebook-list-state" data-kind="empty">
            <BookOpen aria-hidden="true" />
            <span>No notebooks yet.</span>
          </div>
        ) : dashboardModel ? (
          <CloudNotebookDashboard
            model={dashboardModel}
            canRename={signedIn}
            renameState={renameState}
            renameSavingId={renameSavingId}
            onOpenNotebookIntent={preloadNotebookRoute}
            onOpenRename={openRenameForm}
            onCancelRename={closeRenameForm}
            onRenameTitleChange={(title) =>
              setRenameState((current) => (current ? { ...current, title } : current))
            }
            onSaveRename={saveNotebookTitle}
          />
        ) : (
          <div className="cloud-notebook-list-state" data-kind="error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>Unable to project notebook dashboard.</span>
          </div>
        )}
      </section>
    </main>
  );
}

function cloudNotebookListHeaderDetail(
  authState: CloudPrototypeAuthState,
  hasAppSession: boolean,
  authConfig: CloudViewerAuthConfig,
): string {
  if (authState.mode === "oidc_expired" && !hasAppSession) {
    return "Session expired";
  }
  if (authState.mode === "anonymous" && !hasAppSession) {
    return authConfig.localDev ? "Local auth" : "Cloud preview";
  }
  if (authState.mode === "dev") {
    return authState.user ? `Local: ${authState.user}` : "Local auth";
  }
  const firstName = cloudNotebookListFirstName(authState);
  return firstName ? `by ${firstName}` : "Signed in";
}

function cloudNotebookListFirstName(authState: CloudPrototypeAuthState): string | null {
  const claimName =
    authState.oidcClaims?.given_name?.trim() || authState.oidcClaims?.name?.trim() || "";
  if (!claimName || claimName.includes("@")) {
    return null;
  }
  return claimName.split(/\s+/u)[0] ?? null;
}

function cloudNotebookListEndpoint(): string {
  return new URL("api/n?limit=100", `${window.location.origin}/`).href;
}

function cloudNotebookCollectionEndpoint(): string {
  return new URL("api/n", `${window.location.origin}/`).href;
}

function cloudNotebookCatalogEndpoint(notebookId: string): string {
  return new URL(`api/n/${encodeURIComponent(notebookId)}`, `${window.location.origin}/`).href;
}

function cloudAuthWithScope(
  authState: CloudPrototypeAuthState,
  requestedScope: NonNullable<CloudPrototypeAuthState["requestedScope"]>,
): CloudPrototypeAuthState {
  return authState.requestedScope === requestedScope
    ? authState
    : {
        ...authState,
        requestedScope,
      };
}

function initialCloudNotebookListState(
  authState: CloudPrototypeAuthState,
  bootstrap: CloudNotebookListBootstrap | null,
  appSession: CloudAppSession | null,
): CloudNotebookListState {
  const seededNotebooks = cloudNotebookListSeedFromBootstrapOrCache(
    authState,
    bootstrap,
    appSession,
  );
  return seededNotebooks ? { kind: "ready", notebooks: seededNotebooks } : { kind: "loading" };
}

function fetchCloudNotebookList(
  authState: CloudPrototypeAuthState,
  signal: AbortSignal,
): Promise<Response> {
  if (authState.mode === "dev" || authState.mode === "oidc") {
    return fetchWithCloudPrototypeAuth(
      cloudNotebookListEndpoint(),
      { headers: { Accept: "application/json" }, signal },
      authState,
    );
  }
  return fetch(cloudNotebookListEndpoint(), {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
}

function cloudNotebookListSeedFromBootstrapOrCache(
  authState: CloudPrototypeAuthState,
  bootstrap: CloudNotebookListBootstrap | null,
  appSession: CloudAppSession | null,
): CloudNotebookListItem[] | null {
  return bootstrap?.notebooks ?? readCachedCloudNotebookListFromWindow(authState, appSession);
}

function readCachedCloudNotebookListFromWindow(
  authState: CloudPrototypeAuthState,
  appSession: CloudAppSession | null,
): CloudNotebookListItem[] | null {
  const storage = cloudNotebookListCacheStorage();
  return storage ? readCachedCloudNotebookList(storage, authState, appSession) : null;
}

function writeCachedCloudNotebookListToWindow(
  authState: CloudPrototypeAuthState,
  appSession: CloudAppSession | null,
  notebooks: CloudNotebookListItem[],
): void {
  const storage = cloudNotebookListCacheStorage();
  if (!storage) {
    return;
  }
  writeCachedCloudNotebookList(storage, authState, appSession, notebooks);
}

function clearCachedCloudNotebookListFromWindow(): void {
  const storage = cloudNotebookListCacheStorage();
  if (!storage) {
    return;
  }
  clearCachedCloudNotebookList(storage);
}

function cloudNotebookListCacheStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function defaultCloudNotebookTitle(now = new Date()): string {
  const date = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(now);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
  return `Notebook ${date} ${time}`;
}

function isCloudNotebookListResponse(value: unknown): value is CloudNotebookListResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.ok === true && Array.isArray(candidate.notebooks);
}
