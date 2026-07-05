import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { projectNotebookWorkstationSelection } from "runtimed";
import { useTheme } from "@/hooks/useTheme";
import { projectWorkstationsPage, WorkstationsManagementPage } from "@/components/workstations";
import { CloudNotebookSignInButton } from "./cloud-auth-controls";
import type { CloudViewerAuthConfig } from "./cloud-viewer-types";
import {
  useCloudAuthRenewal,
  useCloudAuthState,
  useHostedCatalogAuth,
} from "./use-cloud-auth-store";
import { applyDocumentTheme, CLOUD_VIEWER_THEME_STORAGE_KEY } from "./theme";
import { useCloudStores } from "./cloud-stores-context";
import {
  useCloudWorkstationPairing,
  useCloudWorkstationsController,
  useCloudWorkstationsError,
  useCloudWorkstationsRegistry,
  useCloudWorkstationsStatus,
} from "./use-cloud-workstations-store";

const WORKSTATIONS_ENDPOINT = "/api/workstations";

/**
 * Standalone /workstations route: account-level management of paired
 * machines. Renders only registry-backed facts; sections whose data has no
 * hosted API yet (kernel inventory, idle policy, transport controls, unpair)
 * stay off until the workstation layer grows those endpoints.
 */
export function CloudWorkstationsView({ authConfig }: { authConfig: CloudViewerAuthConfig }) {
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const { workstations: workstationsStore } = useCloudStores();
  const authState = useCloudAuthState();
  const authRenewal = useCloudAuthRenewal();
  const hostedAuth = useHostedCatalogAuth();
  const { canFetchCatalog, waitingForAppSession } = hostedAuth;

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  // The store owns the registry poll and pairing lifecycle. The page has no
  // attach/default mutations; a closed gate flips to loading (while the app
  // session resolves) or signed_out without wiping the last-good registry.
  useCloudWorkstationsController({
    auth: authState,
    workstationsEndpoint: WORKSTATIONS_ENDPOINT,
    defaultEndpoint: undefined,
    attachEndpoint: undefined,
    canFetch: canFetchCatalog,
    panelIsOpen: true,
    gateCadenceUntilSettled: true,
    closedGate: {
      status: waitingForAppSession ? "loading" : "signed_out",
      wipeRegistry: false,
    },
  });

  const status = useCloudWorkstationsStatus();
  const registry = useCloudWorkstationsRegistry();
  const registryError = useCloudWorkstationsError();
  const pairing = useCloudWorkstationPairing();

  const isReady = status === "ready";
  const workstations = isReady ? registry.workstations : [];
  const defaultWorkstationId = isReady ? registry.defaultWorkstationId : null;

  const refreshRegistry = useCallback(() => {
    void workstationsStore.refreshNow();
  }, [workstationsStore]);
  const startPairing = useCallback(() => workstationsStore.startPairing(), [workstationsStore]);
  const cancelPairing = useCallback(() => workstationsStore.cancelPairing(), [workstationsStore]);

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
          {status === "ready" || status === "error" ? (
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
        {status === "loading" || status === "idle" ? (
          <div
            className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading workstations
          </div>
        ) : status === "signed_out" ? (
          <div className="flex flex-col items-center gap-4 py-24 text-center">
            <h2 className="text-lg font-semibold">Sign in to manage workstations</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Workstations are machines you pair to run notebook compute. Sign in to see yours, pair
              a new one, and manage what runs where.
            </p>
            <CloudNotebookSignInButton authConfig={authConfig} authState={authState} />
          </div>
        ) : status === "error" ? (
          <div className="cloud-notebook-list-state" data-kind="error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{registryError}</span>
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
