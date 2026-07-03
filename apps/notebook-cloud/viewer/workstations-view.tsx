import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { projectNotebookWorkstationSelection } from "runtimed";
import { useTheme } from "@/hooks/useTheme";
import { projectWorkstationsPage, WorkstationsManagementPage } from "@/components/workstations";
import { CloudNotebookSignInButton } from "./cloud-auth-controls";
import type { CloudViewerAuthConfig } from "./cloud-viewer-types";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import { useHostedCatalogAuth } from "./use-cloud-auth-store";
import { applyDocumentTheme, CLOUD_VIEWER_THEME_STORAGE_KEY } from "./theme";
import {
  useCloudAppSessionBridge,
  useCloudAppSessionStatus,
  useCloudPrototypeAuth,
} from "./use-cloud-auth";
import { useCloudWorkstationPairing } from "./use-cloud-workstation-pairing";
import {
  CLOUD_WORKSTATIONS_ACTIVE_REFRESH_INTERVAL_MS,
  fetchCloudWorkstations,
  type CloudWorkstationsState,
} from "./workstations-client";

const WORKSTATIONS_ENDPOINT = "/api/workstations";

type CloudWorkstationsViewState =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "error"; message: string }
  | { kind: "ready"; state: CloudWorkstationsState };

/**
 * Standalone /workstations route: account-level management of paired
 * machines. Renders only registry-backed facts; sections whose data has no
 * hosted API yet (kernel inventory, idle policy, transport controls, unpair)
 * stay off until the workstation layer grows those endpoints.
 */
export function CloudWorkstationsView({ authConfig }: { authConfig: CloudViewerAuthConfig }) {
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const appSessionStatus = useCloudAppSessionStatus(null);
  const { authState, authRenewal } = useCloudPrototypeAuth(authConfig, {
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
  const hostedAuth = useHostedCatalogAuth({
    authState,
    appSession: appSessionStatus.session,
    appSessionLoading: appSessionStatus.status === "loading",
  });
  const { canFetchCatalog, waitingForAppSession } = hostedAuth;

  const [viewState, setViewState] = useState<CloudWorkstationsViewState>({ kind: "loading" });
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  const loadWorkstations = useCallback(
    async (authStateForFetch: CloudPrototypeAuthState, signal: AbortSignal) => {
      const next = await fetchCloudWorkstations(WORKSTATIONS_ENDPOINT, authStateForFetch, signal);
      if (signal.aborted) return;
      setViewState({ kind: "ready", state: next });
    },
    [],
  );

  useEffect(() => {
    if (!canFetchCatalog) {
      setViewState(waitingForAppSession ? { kind: "loading" } : { kind: "signed_out" });
      return;
    }
    const controller = new AbortController();
    setViewState((previous) => (previous.kind === "ready" ? previous : { kind: "loading" }));
    void loadWorkstations(authState, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setViewState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return () => controller.abort();
  }, [authState, canFetchCatalog, loadWorkstations, refreshIndex, waitingForAppSession]);

  // Background refresh keeps status spines honest while the page stays open.
  // Chained timeouts serialize refreshes so ticks never overlap or land out of
  // order, and cleanup aborts the in-flight fetch; otherwise a slow fetch from
  // a signed-out session could land late and overwrite the signed_out state
  // with stale registry data.
  useEffect(() => {
    if (!canFetchCatalog || viewState.kind !== "ready") {
      return;
    }
    let disposed = false;
    let timer: number | null = null;
    let activeController: AbortController | null = null;
    const scheduleRefresh = () => {
      timer = window.setTimeout(() => {
        const controller = new AbortController();
        activeController = controller;
        void loadWorkstations(authState, controller.signal)
          .catch(() => {
            // Transient refresh failures keep the last good registry view.
          })
          .finally(() => {
            if (activeController === controller) {
              activeController = null;
            }
            if (!disposed) {
              scheduleRefresh();
            }
          });
      }, CLOUD_WORKSTATIONS_ACTIVE_REFRESH_INTERVAL_MS);
    };
    scheduleRefresh();
    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      activeController?.abort();
    };
  }, [authState, canFetchCatalog, loadWorkstations, viewState.kind]);

  const workstations = viewState.kind === "ready" ? viewState.state.workstations : [];
  const defaultWorkstationId =
    viewState.kind === "ready" ? viewState.state.defaultWorkstationId : null;

  const refreshRegistry = useCallback(() => {
    setRefreshIndex((value) => value + 1);
  }, []);

  const { pairing, startPairing, cancelPairing } = useCloudWorkstationPairing({
    workstationsEndpoint: WORKSTATIONS_ENDPOINT,
    authState,
    workstations,
    onRegistered: refreshRegistry,
  });

  const pageView = useMemo(() => {
    const selection = projectNotebookWorkstationSelection({
      registeredWorkstations: workstations,
      defaultWorkstationId,
    });
    return projectWorkstationsPage(selection.registeredWorkstations);
  }, [defaultWorkstationId, workstations]);

  useEffect(() => {
    if (pageView.items.length === 0) {
      return;
    }
    setSelectedId((current) =>
      current && pageView.items.some((item) => item.id === current)
        ? current
        : (pageView.items.find((item) => item.id === defaultWorkstationId)?.id ??
          pageView.items[0]?.id ??
          null),
    );
  }, [defaultWorkstationId, pageView]);

  return (
    <main className="cloud-notebook-list-page nb-app">
      <header className="nb-header">
        <div className="nb-header-inner">
          <a className="nb-brand" href="/n">
            <span className="nb-brand-mark" aria-hidden="true" />
            <span className="nb-brand-name">nteract</span>
            <span className="nb-brand-sep">/</span>
            <span className="nb-brand-scope">workstations</span>
          </a>
          <span className="nb-header-spacer" />
          {viewState.kind === "ready" || viewState.kind === "error" ? (
            <div className="nb-header-actions">
              <Button
                type="button"
                variant="outline"
                aria-label="Refresh workstations"
                onClick={refreshRegistry}
              >
                <RotateCcw aria-hidden="true" />
                <span className="nb-btn-label">Refresh</span>
              </Button>
            </div>
          ) : null}
        </div>
      </header>

      {authRenewal.kind !== "idle" && !hostedAuth.hasAppSession ? (
        <div
          className="cloud-notebook-list-banner"
          data-kind={authRenewal.kind === "failed" ? "error" : "info"}
          role={authRenewal.kind === "failed" ? "alert" : "status"}
        >
          {authRenewal.message}
        </div>
      ) : null}

      <section
        className="mx-auto w-full max-w-[1188px] flex-1 px-6 pb-10 pt-6"
        aria-label="Workstations"
      >
        {viewState.kind === "loading" ? (
          <div
            className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading workstations
          </div>
        ) : viewState.kind === "signed_out" ? (
          <div className="flex flex-col items-center gap-4 py-24 text-center">
            <h2 className="text-lg font-semibold">Sign in to manage workstations</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Workstations are machines you pair to run notebook compute. Sign in to see yours, pair
              a new one, and manage what runs where.
            </p>
            <CloudNotebookSignInButton authConfig={authConfig} authState={authState} />
          </div>
        ) : viewState.kind === "error" ? (
          <div className="cloud-notebook-list-state" data-kind="error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{viewState.message}</span>
            <Button type="button" variant="outline" size="sm" onClick={refreshRegistry}>
              <RotateCcw aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : (
          <WorkstationsManagementPage
            className="h-[calc(100vh-152px)] min-h-[480px]"
            view={pageView}
            selectedId={selectedId}
            onSelect={setSelectedId}
            pairing={pairing}
            onStartPairing={() => {
              void startPairing();
            }}
            onCancelPairing={cancelPairing}
          />
        )}
      </section>
    </main>
  );
}
