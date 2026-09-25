import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { asyncScheduler, filter, fromEvent, merge } from "rxjs";
import { useCloudStores } from "./cloud-stores-context";
import { useCloudNotebookHomeState } from "./use-cloud-notebook-home-store";
import { notebookHomeEvents, notebookHomeEventsUrl } from "./notebook-home-events";
import { NotebookHomeAccessError } from "./cloud-notebook-home-store";
import {
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  Loader2,
  LogOut,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
// Not the `@/components/notebook` barrel: it pulls the notebook route into this
// chunk and collapses the notebook-route CSS split `copy-viewer-assets` needs.
import { NotebookAccountMenu } from "@/components/notebook/NotebookAccountMenu";
import { NotebookSettingsDrawer } from "@/components/notebook/NotebookSettingsDrawer";
import type { NotebookActorIdentity } from "@/components/notebook/capabilities";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useColorThemePreference } from "@/hooks/useColorThemePreference";
import { useTheme } from "@/hooks/useTheme";
import {
  clearCloudPrototypeDevAuth,
  fetchWithCloudPrototypeAuth,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { cloudResponseError } from "./cloud-response";
import { clearCloudAppSession } from "./app-session";
import {
  CloudNotebookDashboard,
  CloudNotebookDashboardLoading,
  CloudNotebookDashboardSearchInput,
} from "./cloud-notebook-dashboard-view";
import {
  useCloudAppSession,
  useCloudAuthRenewal,
  useCloudAuthState,
  useHostedCatalogAuth,
} from "./use-cloud-auth-store";
import { useCloudAuthStore } from "./cloud-auth-context";
import { loadCloudNotebookListBootstrap } from "./cloud-viewer-config";
import type { CloudAppSession } from "./app-session";
import type {
  CloudNotebookCreateResponse,
  CloudNotebookListBootstrap,
  CloudNotebookListResponse,
  CloudNotebookListSnapshot,
  CloudNotebookRenameState,
  CloudNotebookUpdateResponse,
  CloudViewerAuthConfig,
} from "./cloud-viewer-types";
import {
  cloudNotebookOpenUrlWithMode,
  isCloudNotebookListItem,
  isOptionalCloudNotebookListTotalCount,
  normalizeCloudNotebookListTotalCount,
  projectCloudNotebookDashboard,
  type CloudNotebookListItem,
} from "./notebook-dashboard";
import {
  clearCachedCloudNotebookList,
  readCachedCloudNotebookList,
  writeCachedCloudNotebookList,
} from "./notebook-list-cache";
import {
  applyDocumentTheme,
  CLOUD_VIEWER_COLOR_THEME_STORAGE_KEY,
  CLOUD_VIEWER_THEME_STORAGE_KEY,
} from "./theme";
import { CloudNotebookSignInButton } from "./cloud-auth-controls";
import { preloadNotebookRoute } from "./notebook-route-preload";

const CLOUD_NOTEBOOK_LIST_APP_SESSION_WAIT_DEADLINE_MS = 8_000;
const CLOUD_NOTEBOOK_LIST_FETCH_TIMEOUT_MS = 20_000;

export interface CloudNotebookListViewProps {
  authConfig: CloudViewerAuthConfig;
  appSessionWaitDeadlineMs?: number;
}

export function CloudNotebookListView({
  appSessionWaitDeadlineMs,
  authConfig,
}: CloudNotebookListViewProps) {
  const { theme, setTheme, resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const { colorTheme, setColorTheme } = useColorThemePreference(
    CLOUD_VIEWER_COLOR_THEME_STORAGE_KEY,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const auth = useCloudAuthStore();
  const [bootstrap] = useState<CloudNotebookListBootstrap | null>(() =>
    loadCloudNotebookListBootstrap(),
  );
  const appSessionStatus = useCloudAppSession();
  const authState = useCloudAuthState();
  const authRenewal = useCloudAuthRenewal();
  const { notebookHome } = useCloudStores();
  const identityKey = appSessionStatus.session
    ? `session:${appSessionStatus.session.cache_key}`
    : authState.mode === "dev" && authState.token
      ? `dev:${authState.user ?? "browser-editor"}`
      : authState.oidcClaims?.sub
        ? `oidc:${authState.oidcClaims.sub}`
        : null;
  useState(() => {
    notebookHome.seed(
      cloudNotebookListSeedFromBootstrapOrCache(authState, appSessionStatus.session, bootstrap),
      identityKey,
    );
    return null;
  });
  const {
    list: listState,
    displayName: currentUserDisplay,
    avatar: currentUserAvatar,
  } = useCloudNotebookHomeState();
  const [createState, setCreateState] = useState<"idle" | "starting">("idle");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState(() => defaultCloudNotebookTitle());
  const [dashboardQuery, setDashboardQuery] = useState("");
  const [renameState, setRenameState] = useState<CloudNotebookRenameState | null>(null);
  const [renameSavingId, setRenameSavingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const hostedAuth = useHostedCatalogAuth();
  const {
    canFetchCatalog: canFetchNotebookList,
    hasAppSession,
    signedIn,
    waitingForAppSession,
  } = hostedAuth;
  // A cookie-only login has no browser identity until the session GET settles.
  // Keep the dashboard shell while that request is pending, just as we do for
  // the browser-token session exchange, instead of flashing the sign-in panel.
  const waitingForSession =
    waitingForAppSession || (!canFetchNotebookList && appSessionStatus.status === "loading");
  const appSessionWaitDeadline =
    appSessionWaitDeadlineMs ?? CLOUD_NOTEBOOK_LIST_APP_SESSION_WAIT_DEADLINE_MS;
  const dashboardModel = useMemo(
    () =>
      listState.kind === "ready"
        ? projectCloudNotebookDashboard(listState.notebooks, { totalCount: listState.totalCount })
        : null,
    [listState],
  );

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    // Bootstrap is consumed at mount. Reusing it here can resurrect items
    // removed by a newer authorized snapshot when credentials renew.
    const seed = readCachedCloudNotebookListFromLocalStorage(authState, appSessionStatus.session);
    const target = notebookHomeEventsUrl(
      new URL("api/notebook-home/events", `${window.location.origin}/`).href,
      authState,
      hasAppSession,
    );
    return notebookHome.activate({
      identityKey,
      gate: canFetchNotebookList ? "open" : waitingForSession ? "waiting" : "closed",
      seed,
      waitMs: Math.max(0, appSessionWaitDeadline),
      scheduler: asyncScheduler,
      load: async (signal) => {
        const response = await fetchCloudNotebookList(
          authState,
          AbortSignal.any([signal, AbortSignal.timeout(CLOUD_NOTEBOOK_LIST_FETCH_TIMEOUT_MS)]),
        );
        if (response.status === 401 || response.status === 403)
          throw new NotebookHomeAccessError("Sign in to list notebooks");
        if (!response.ok) throw await cloudResponseError(response, "Unable to list notebooks");
        const body: unknown = await response.json();
        if (!isCloudNotebookListResponse(body))
          throw new Error("Unable to list notebooks: response shape was invalid");
        return body;
      },
      events: notebookHomeEvents(() => new WebSocket(target.url, target.protocols), asyncScheduler),
      wake: merge(
        fromEvent(window, "online"),
        fromEvent(document, "visibilitychange").pipe(
          filter(() => document.visibilityState === "visible"),
        ),
      ),
      saved: (body) =>
        writeCachedCloudNotebookListToLocalStorage(authState, appSessionStatus.session, {
          notebooks: body.notebooks,
          principal: body.current_user_principal,
          totalCount: normalizeCloudNotebookListTotalCount(body.notebooks, body.total_count),
        }),
      clear: clearCachedCloudNotebookListFromLocalStorage,
    });
  }, [
    appSessionStatus.session,
    appSessionWaitDeadline,
    authState,
    canFetchNotebookList,
    hasAppSession,
    identityKey,
    notebookHome,
    waitingForSession,
  ]);

  const refreshList = () => notebookHome.refresh();

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

    const identityEpoch = notebookHome.identityEpoch;
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
      if (notebookHome.identityEpoch !== identityEpoch) return;
      notebookHome.refresh();
      setRenameState(null);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setRenameSavingId(null);
    }
  };

  const signOut = () => {
    setDashboardQuery("");
    auth.clearAppSessionStatus();
    clearCachedCloudNotebookListFromLocalStorage();
    void clearCloudAppSession()
      .catch((error: unknown) => {
        console.warn("[notebook-cloud] app session clear failed", error);
      })
      .finally(() => auth.refreshAppSessionStatus());
    clearCloudPrototypeDevAuth(window.localStorage);
    auth.refreshAuthState();
  };

  const displayName = appSessionStatus.session?.display_name ?? currentUserDisplay;
  const headerDetail = cloudNotebookListHeaderDetail(
    authState,
    hasAppSession,
    authConfig,
    displayName,
  );
  // Cookie-only boots hydrate the validated name through session status. The
  // list response remains a fallback for browser-token and local-dev flows.
  const currentUserActor = cloudNotebookListCurrentUserActor(
    authState,
    displayName,
    currentUserAvatar,
  );
  const currentUserAccountDetail = cloudNotebookListAccountDetail(authState, displayName);

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
          {signedIn || waitingForSession ? (
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
                  disabled={!signedIn || listState.kind === "loading"}
                  onClick={refreshList}
                >
                  <RotateCcw aria-hidden="true" />
                  <span className="nb-btn-label">Refresh</span>
                </Button>
                <Button
                  type="button"
                  disabled={!signedIn || createState === "starting"}
                  onClick={openCreateForm}
                >
                  {createState === "starting" ? (
                    <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
                  ) : (
                    <Plus aria-hidden="true" />
                  )}
                  {createState === "starting" ? "Creating" : "New notebook"}
                </Button>
                {signedIn ? (
                  <NotebookAccountMenu
                    actor={currentUserActor}
                    detail={displayName ?? headerDetail}
                    accountDetail={currentUserAccountDetail}
                  >
                    <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                      <Settings aria-hidden="true" />
                      Settings
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={signOut}>
                      <LogOut aria-hidden="true" />
                      Sign out
                    </DropdownMenuItem>
                  </NotebookAccountMenu>
                ) : (
                  <span className="nb-account-pending" aria-hidden="true" />
                )}
              </div>
            </>
          ) : null}
        </div>
      </header>

      {/*
       * Suppressed once the list has actually fallen to the signed-out panel:
       * that panel is already the sign-in invitation, so a renewal notice
       * above it would either restate "sign in" as an alarm or, worse, show
       * a stale "refreshing" message the user has no live session for. This
       * banner is for the case where a session is live (dashboard visible)
       * and renewal just failed under it.
       */}
      {authRenewal.kind !== "idle" && !hasAppSession && listState.kind !== "signed_out" ? (
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
      <NotebookSettingsDrawer
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        theme={theme}
        onThemeChange={setTheme}
        colorTheme={colorTheme}
        onColorThemeChange={setColorTheme}
        actor={signedIn ? currentUserActor : null}
        accountDetail={currentUserAccountDetail}
        accountActions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => {
              setSettingsOpen(false);
              signOut();
            }}
          >
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        }
      />

      <section className="cloud-notebook-list-content" aria-label="Notebook list">
        {listState.kind === "loading" ? (
          <CloudNotebookDashboardLoading />
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
  displayName: string | null,
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
  const firstName = cloudNotebookListFirstName(authState, displayName);
  return firstName ? `by ${firstName}` : "Signed in";
}

function cloudNotebookListCurrentUserActor(
  authState: CloudPrototypeAuthState,
  displayName: string | null,
  avatarUrl: string | null,
): NotebookActorIdentity {
  const label =
    displayName?.trim() ||
    authState.oidcClaims?.name?.trim() ||
    authState.oidcClaims?.email?.trim() ||
    (authState.mode === "dev" ? authState.user?.trim() : "") ||
    "You";
  const id =
    authState.oidcClaims?.sub?.trim() ||
    (authState.mode === "dev" ? authState.user?.trim() : "") ||
    authState.oidcClaims?.email?.trim() ||
    "you";
  return {
    id,
    label,
    detail: null,
    kind: "human",
    imageUrl: avatarUrl,
  };
}

function cloudNotebookListAccountDetail(
  authState: CloudPrototypeAuthState,
  displayName: string | null,
): string | null {
  const email = authState.oidcClaims?.email?.trim();
  if (!email) {
    return authState.mode === "dev" ? "Local auth" : null;
  }
  const label = displayName?.trim() || authState.oidcClaims?.name?.trim() || "";
  return email === label ? null : email;
}

function cloudNotebookListFirstName(
  authState: CloudPrototypeAuthState,
  displayName: string | null,
): string | null {
  const claimName =
    displayName?.trim() ||
    authState.oidcClaims?.given_name?.trim() ||
    authState.oidcClaims?.name?.trim() ||
    "";
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
): CloudNotebookListSnapshot | null {
  return bootstrap && bootstrap.session?.cache_key === appSession?.cache_key
    ? {
        notebooks: bootstrap.notebooks,
        totalCount: normalizeCloudNotebookListTotalCount(
          bootstrap.notebooks,
          bootstrap.total_count,
        ),
      }
    : readCachedCloudNotebookListFromLocalStorage(authState, appSession);
}

function readCachedCloudNotebookListFromLocalStorage(
  authState: CloudPrototypeAuthState,
  appSession: CloudAppSession | null | undefined,
): CloudNotebookListSnapshot | null {
  const storage = cloudNotebookListCacheStorage();
  return storage ? readCachedCloudNotebookList(storage, authState, appSession) : null;
}

function writeCachedCloudNotebookListToLocalStorage(
  authState: CloudPrototypeAuthState,
  appSession: CloudAppSession | null | undefined,
  input: {
    notebooks: CloudNotebookListItem[];
    principal?: string | null;
    totalCount: number;
  },
): void {
  const storage = cloudNotebookListCacheStorage();
  if (!storage) {
    return;
  }
  writeCachedCloudNotebookList(storage, authState, appSession, input.notebooks, {
    principal: input.principal,
    totalCount: input.totalCount,
  });
}

function clearCachedCloudNotebookListFromLocalStorage(): void {
  const storage = cloudNotebookListCacheStorage();
  if (!storage) {
    return;
  }
  clearCachedCloudNotebookList(storage);
}

function cloudNotebookListCacheStorage(): Storage | null {
  try {
    return window.localStorage;
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
  return (
    candidate.ok === true &&
    Array.isArray(candidate.notebooks) &&
    candidate.notebooks.every(isCloudNotebookListItem) &&
    isOptionalCloudNotebookListTotalCount(candidate.total_count, candidate.notebooks.length)
  );
}
