import { lazy, Profiler, Suspense, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BookOpen, House, Loader2 } from "lucide-react";
import { ErrorBoundary } from "@/lib/error-boundary";
import { setLoggerHost } from "@/lib/logger";
import { setOpenUrlHost } from "@/lib/open-url";
import { installDocumentThemeSync } from "./theme";
import {
  isHomePath,
  isNotebookListPath,
  isWorkstationsPath,
  loadAuthConfig,
  loadCloudNotebookListBootstrap,
  loadViewerRuntime,
  requireElement,
} from "./cloud-viewer-config";
import type { CloudViewerAuthConfig, ViewerRuntimeState } from "./cloud-viewer-types";
import { cloudAuthStore } from "./cloud-auth-store";
import { cloudNotebookModeFromSearch } from "./cloud-notebook-mode";
import { cloudNotebookRouteTitleFromPathname } from "./cloud-notebook-title-state";
import { CloudHomeView } from "./home-view";
import { CloudNotebookListView } from "./notebook-list-view";
import { loadNotebookRouteModule } from "./notebook-route-preload";
import { installStaleDeploymentRecovery } from "./stale-deployment-recovery";
import "./index.css";

installStaleDeploymentRecovery();

const NotebookRoute = lazy(() =>
  loadNotebookRouteModule().then((module) => ({ default: module.NotebookRoute })),
);

// Boot-path discipline: only the auth store may ride the entry chunk (its
// synchronous seed is what instant paint reads). The workstations surface -
// store, hooks, and the management page UI - belongs to its route's chunk, so
// notebook and dashboard visitors never download it.
const CloudWorkstationsView = lazy(() =>
  import("./workstations-view").then((module) => ({ default: module.CloudWorkstationsView })),
);

setLoggerHost({
  debug: () => {},
  info: () => {},
  warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
  error: (message: string, ...args: unknown[]) => console.error(message, ...args),
});

setOpenUrlHost({
  externalLinks: {
    async open(url: string): Promise<void> {
      window.open(url, "_blank", "noopener,noreferrer");
    },
  },
});

installDocumentThemeSync();

/**
 * Start the app-wide auth store before React's first render, so the drivers own
 * auth/app-session from boot and the seeded snapshot is available to the
 * instant-paint matcher (F7). Config is route-derived: the notebook route seeds
 * the bootstrap session and enables OIDC refresh for edit-mode links (the store
 * ORs in a live app session), while the other routes always keep sign-in fresh.
 */
function bootCloudAuthStore(): void {
  const authConfig = loadAuthConfig();
  if (isHomePath() || isWorkstationsPath()) {
    cloudAuthStore.activate({ authConfig, initialSession: null, appSessionRefreshFallback: true });
    return;
  }
  if (isNotebookListPath()) {
    cloudAuthStore.activate({
      authConfig,
      initialSession: loadCloudNotebookListBootstrap()?.session ?? null,
      appSessionRefreshFallback: true,
    });
    return;
  }
  const runtime = loadViewerRuntime();
  const initialSession = runtime.kind === "ready" ? (runtime.runtime.config.session ?? null) : null;
  cloudAuthStore.activate({
    authConfig,
    initialSession,
    appSessionRefreshFallback: true,
    autoRefreshOidc: cloudNotebookModeFromSearch(window.location.search) === "edit",
  });
}

bootCloudAuthStore();

function App() {
  const [authConfig] = useState<CloudViewerAuthConfig>(() => loadAuthConfig());
  const [runtimeState] = useState<ViewerRuntimeState | null>(() =>
    isHomePath() || isNotebookListPath() || isWorkstationsPath() ? null : loadViewerRuntime(),
  );

  if (isHomePath()) {
    // The Worker currently redirects / and /index.html to /n. Keep this route
    // mounted for the temporary redirect's rollback path and future home-page
    // experiments that may serve the viewer shell directly again.
    return <CloudHomeView authConfig={authConfig} />;
  }

  if (isNotebookListPath()) {
    return <CloudNotebookListView authConfig={authConfig} />;
  }

  if (isWorkstationsPath()) {
    return (
      <Suspense fallback={<ViewerStartupLoading title="Workstations" />}>
        <CloudWorkstationsView authConfig={authConfig} />
      </Suspense>
    );
  }

  if (!runtimeState) {
    return <ViewerStartupError message="Unable to start cloud viewer: missing runtime state" />;
  }
  if (runtimeState.kind === "error") {
    return <ViewerStartupError message={`Unable to start cloud viewer: ${runtimeState.message}`} />;
  }

  return (
    <Suspense
      fallback={
        <ViewerStartupLoading
          title={cloudNotebookRouteTitleFromPathname(window.location.pathname).title}
        />
      }
    >
      <NotebookRoute runtime={runtimeState.runtime} authConfig={authConfig} />
    </Suspense>
  );
}

function ViewerStartupError({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen w-full flex-col px-8 py-4 pr-4">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-normal">nteract cloud notebook</h1>
      </header>
      <div className="cloud-state" data-kind="error">
        {message}
      </div>
    </main>
  );
}

function ViewerStartupLoading({ title }: { title: string }) {
  return (
    <main className="cloud-startup-shell" aria-busy="true">
      <header className="cloud-startup-toolbar">
        <div className="cloud-notebook-title-group">
          <a className="cloud-notebook-home-link" href="/n" aria-label="Open notebooks dashboard">
            <House aria-hidden="true" />
          </a>
          <div className="cloud-notebook-title">
            <h1 className="cloud-startup-title">{title}</h1>
            <p className="cloud-startup-status" role="status">
              <Loader2 aria-hidden="true" />
              Opening notebook
            </p>
          </div>
        </div>
        <div className="cloud-startup-toolbar-actions" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </header>
      <div className="cloud-startup-workspace" aria-hidden="true">
        <aside className="cloud-startup-rail">
          <BookOpen aria-hidden="true" />
          <span />
        </aside>
        <section className="cloud-startup-stage">
          <div className="cloud-startup-cell">
            <span className="cloud-startup-line cloud-startup-line--wide" />
            <span className="cloud-startup-line" />
            <span className="cloud-startup-line cloud-startup-line--short" />
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * Dev/profiling instrumentation, not a product surface. When the viewer URL
 * carries `?profile=1`, wrap the root in a React `<Profiler>` that tallies
 * commit counts on `window.__nteractRenderCounts` keyed by Profiler id, for the
 * local profiling harness (`scripts/profile-local.mjs`) to read after settle.
 * Invariant: without the flag no Profiler mounts and nothing attaches to
 * window; the tree is returned unchanged. The helper itself and its one
 * URLSearchParams parse still ship in the normal bundle.
 */
function withRenderProfiler(node: ReactNode): ReactNode {
  if (new URLSearchParams(window.location.search).get("profile") !== "1") {
    return node;
  }
  const counters = ((
    window as unknown as { __nteractRenderCounts?: Record<string, number> }
  ).__nteractRenderCounts ??= {});
  return (
    <Profiler
      id="cloud-viewer-app"
      onRender={(id) => {
        counters[id] = (counters[id] ?? 0) + 1;
      }}
    >
      {node}
    </Profiler>
  );
}

createRoot(requireElement("#root")).render(
  <ErrorBoundary
    fallback={(error) => <ViewerStartupError message={`Cloud viewer crashed: ${error.message}`} />}
  >
    {withRenderProfiler(<App />)}
  </ErrorBoundary>,
);
