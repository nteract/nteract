import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  Loader2,
  LogOut,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTheme } from "@/hooks/useTheme";
import {
  clearCloudPrototypeDevAuth,
  fetchWithCloudPrototypeAuth,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { cloudResponseError } from "./cloud-response";
import { clearCloudAppSession, establishCloudAppSession } from "./app-session";
import {
  CloudNotebookDashboard,
  CloudNotebookDashboardSearchInput,
} from "./cloud-notebook-dashboard-view";
import { useHostedCatalogAuth } from "./use-cloud-auth-store";
import { loadCloudNotebookListBootstrap } from "./cloud-viewer-config";
import type { CloudAppSession } from "./app-session";
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
import { CloudNotebookSignInButton } from "./cloud-auth-controls";
import { preloadNotebookRoute } from "./notebook-route-preload";

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
    initialCloudNotebookListState(authState, bootstrap),
  );
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [createState, setCreateState] = useState<"idle" | "starting">("idle");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState(() => defaultCloudNotebookTitle());
  const [dashboardQuery, setDashboardQuery] = useState("");
  const [renameState, setRenameState] = useState<CloudNotebookRenameState | null>(null);
  const [renameSavingId, setRenameSavingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const hostedAuth = useHostedCatalogAuth({
    authState,
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
    const seededNotebooks = cloudNotebookListSeedFromBootstrapOrCache(
      authState,
      appSessionStatus.session,
      bootstrap,
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
        const response = await fetchCloudNotebookList(
          authState,
          AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        );
        if (controller.signal.aborted) return;
        if (!response.ok) {
          throw await cloudResponseError(response, "Unable to list notebooks");
        }
        const body = (await response.json()) as unknown;
        if (!isCloudNotebookListResponse(body)) {
          throw new Error("Unable to list notebooks: response shape was invalid");
        }
        writeCachedCloudNotebookListToWindow(authState, appSessionStatus.session, body.notebooks);
        if (typeof body.current_user_display === "string" && body.current_user_display.trim()) {
          setCurrentUserDisplay(body.current_user_display.trim());
        }
        setListState({ kind: "ready", notebooks: body.notebooks });
      } catch (error) {
        if (controller.signal.aborted) return;
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        setListState({
          kind: "error",
          message: timedOut
            ? "Loading notebooks timed out - the service may be mid-deploy. Retry, or hard-refresh if this persists."
            : error instanceof Error
              ? error.message
              : String(error),
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
    setDashboardQuery("");
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
  const [currentUserDisplay, setCurrentUserDisplay] = useState<string | null>(null);
  // Prefer the unified user store's display name (delivered with the list
  // response) over auth-claim parsing for the header identity.
  const currentUserInitials = currentUserDisplay
    ? cloudNotebookInitialsFromLabel(currentUserDisplay)
    : cloudNotebookListCurrentUserInitials(authState);

  return (
    <main className="cloud-notebook-list-page nb-app">
      <header className="nb-header">
        <div className="nb-header-inner">
          <a className="nb-brand" href="/n">
            <span className="nb-brand-mark" aria-hidden="true" />
            <span className="nb-brand-name">nteract</span>
            <span className="nb-brand-sep">/</span>
            <span className="nb-brand-scope">{headerDetail}</span>
          </a>
          <span className="nb-header-spacer" />
          {signedIn ? (
            <>
              <label className="nb-search">
                <Search aria-hidden="true" />
                <CloudNotebookDashboardSearchInput
                  query={dashboardQuery}
                  disabled={listState.kind !== "ready"}
                  onQueryChange={setDashboardQuery}
                />
              </label>
              <div className="nb-header-actions">
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Refresh notebooks"
                  disabled={listState.kind === "loading"}
                  onClick={refreshList}
                >
                  <RotateCcw aria-hidden="true" />
                  <span className="nb-btn-label">Refresh</span>
                </Button>
                <Button
                  type="button"
                  disabled={createState === "starting"}
                  onClick={openCreateForm}
                >
                  {createState === "starting" ? (
                    <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
                  ) : (
                    <Plus aria-hidden="true" />
                  )}
                  {createState === "starting" ? "Creating" : "New notebook"}
                </Button>
                <Button type="button" variant="ghost" aria-label="Sign out" onClick={signOut}>
                  <LogOut aria-hidden="true" />
                  <span className="nb-btn-label">Sign out</span>
                </Button>
                <span className="nb-avatar-me" title={currentUserDisplay ?? headerDetail}>
                  {currentUserInitials}
                </span>
              </div>
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
      {renameError ? (
        <div className="cloud-notebook-list-banner" data-kind="error" role="alert">
          {renameError}
        </div>
      ) : null}
      {createFormOpen ? (
        <CloudNotebookCreateDialog
          title={createTitle}
          createState={createState}
          error={createError}
          onClose={closeCreateForm}
          onCreate={createNotebook}
          onTitleChange={setCreateTitle}
        />
      ) : null}

      <section className="cloud-notebook-list-content" aria-label="Notebook list">
        {listState.kind === "loading" ? (
          <div className="nb-loading" role="status" aria-label="Loading notebooks">
            <span className="sr-only">Loading notebooks</span>
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="nb-loading-row" aria-hidden="true">
                <span className="nb-loading-bar" data-w="title" />
                <span className="nb-loading-bar" data-w="meta" />
                <span className="nb-loading-bar" data-w="meta" />
                <span className="nb-loading-bar" data-w="time" />
              </div>
            ))}
          </div>
        ) : listState.kind === "signed_out" ? (
          <CloudNotebookSignedOutPanel authConfig={authConfig} authState={authState} />
        ) : listState.kind === "error" ? (
          <div className="cloud-notebook-list-state" data-kind="error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{listState.message}</span>
            <Button type="button" variant="outline" size="sm" onClick={refreshList}>
              <RotateCcw aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : listState.notebooks.length === 0 ? (
          <CloudNotebookListEmptyState signedIn={signedIn} onNewNotebook={openCreateForm} />
        ) : dashboardModel ? (
          <CloudNotebookDashboard
            model={dashboardModel}
            canRename={signedIn}
            query={dashboardQuery}
            renameState={renameState}
            renameSavingId={renameSavingId}
            onOpenNotebookIntent={preloadNotebookRoute}
            onOpenRename={openRenameForm}
            onCancelRename={closeRenameForm}
            onQueryChange={setDashboardQuery}
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

function CloudNotebookSignedOutPanel({
  authConfig,
  authState,
}: {
  authConfig: CloudViewerAuthConfig;
  authState: CloudPrototypeAuthState;
}) {
  const localMode = Boolean(authConfig.localDev);
  return (
    <div className="cloud-notebook-signed-out" aria-labelledby="cloud-notebook-signed-out-title">
      <div className="cloud-notebook-signed-out-copy">
        <div className="cloud-notebook-signed-out-kicker">
          <Sparkles aria-hidden="true" />
          {localMode ? "LOCAL MODE" : "NTERACT"}
        </div>
        <h2 id="cloud-notebook-signed-out-title">
          {localMode ? "Open local notebooks." : "Bring computation to life."}
        </h2>
        <p>
          {localMode
            ? "Use local auth to create notebooks and test the live room on this machine."
            : "Sign in to create live notebooks, share work with colleagues, and attach compute."}
        </p>
      </div>
      <div className="cloud-notebook-signed-out-actions">
        <CloudNotebookSignInButton authConfig={authConfig} authState={authState} />
        <a href="https://nteract.io/" target="_blank" rel="noreferrer">
          Visit nteract.io
          <ArrowUpRight aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

function CloudNotebookCreateDialog({
  title,
  createState,
  error,
  onClose,
  onCreate,
  onTitleChange,
}: {
  title: string;
  createState: "idle" | "starting";
  error: string | null;
  onClose: () => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onTitleChange: (title: string) => void;
}) {
  const busy = createState === "starting";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // The shared Dialog owns focus trap, background inerting, Escape, and
        // focus restore. Ignore close requests while the create is in flight.
        if (!open && !busy) {
          onClose();
        }
      }}
    >
      <DialogContent className="nb-create-dialog" showCloseButton={!busy}>
        <form onSubmit={onCreate}>
          <DialogHeader>
            <DialogTitle>New notebook</DialogTitle>
            <DialogDescription>
              Give it a title now, or rename it later from the dashboard.
            </DialogDescription>
          </DialogHeader>
          <div className="nb-field">
            <label htmlFor="cloud-new-notebook-title">Title</label>
            <Input
              id="cloud-new-notebook-title"
              type="text"
              value={title}
              maxLength={160}
              disabled={busy}
              placeholder="Untitled notebook"
              onChange={(event) => onTitleChange(event.currentTarget.value)}
            />
          </div>
          {error ? (
            <div className="cloud-notebook-list-banner" data-kind="error" role="alert">
              {error}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? (
                <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
              ) : (
                <Plus aria-hidden="true" />
              )}
              {busy ? "Creating" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CloudNotebookListEmptyState({
  signedIn,
  onNewNotebook,
}: {
  signedIn: boolean;
  onNewNotebook: () => void;
}) {
  return (
    <div className="nb-empty">
      <span className="nb-empty-badge">
        <BookOpen aria-hidden="true" />
      </span>
      <h2>No notebooks yet</h2>
      <p>Create a notebook to start working with a live document and attach compute when needed.</p>
      {signedIn ? (
        <Button type="button" onClick={onNewNotebook}>
          <Plus aria-hidden="true" />
          New notebook
        </Button>
      ) : null}
    </div>
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

function cloudNotebookListCurrentUserInitials(authState: CloudPrototypeAuthState): string {
  const label =
    authState.oidcClaims?.name?.trim() ||
    authState.oidcClaims?.email?.trim() ||
    (authState.mode === "dev" ? authState.user?.trim() : "") ||
    "You";
  return cloudNotebookInitialsFromLabel(label);
}

function cloudNotebookInitialsFromLabel(label: string): string {
  const parts = label
    .replace(/[_+.-]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const initials =
    parts.length >= 2
      ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`
      : (parts[0]?.slice(0, 2) ?? "YO");
  return initials.toUpperCase();
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
): CloudNotebookListState {
  const seededNotebooks = cloudNotebookListSeedFromBootstrapOrCache(
    authState,
    bootstrap?.session ?? null,
    bootstrap,
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
  appSession: CloudAppSession | null | undefined,
  bootstrap: CloudNotebookListBootstrap | null,
): CloudNotebookListItem[] | null {
  return bootstrap?.notebooks ?? readCachedCloudNotebookListFromWindow(authState, appSession);
}

function readCachedCloudNotebookListFromWindow(
  authState: CloudPrototypeAuthState,
  appSession: CloudAppSession | null | undefined,
): CloudNotebookListItem[] | null {
  const storage = cloudNotebookListCacheStorage();
  return storage ? readCachedCloudNotebookList(storage, authState, appSession) : null;
}

function writeCachedCloudNotebookListToWindow(
  authState: CloudPrototypeAuthState,
  appSession: CloudAppSession | null | undefined,
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
