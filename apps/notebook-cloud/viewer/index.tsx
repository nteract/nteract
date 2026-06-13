import { lazy, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/lib/error-boundary";
import { setLoggerHost } from "../../notebook/src/lib/logger";
import { setOpenUrlHost } from "../../notebook/src/lib/open-url";
import { installDocumentThemeSync } from "./theme";
import {
  isHomePath,
  isNotebookListPath,
  isOidcCallbackPath,
  loadAuthConfig,
  loadViewerRuntime,
  requireElement,
} from "./cloud-viewer-config";
import type { CloudViewerAuthConfig, ViewerRuntimeState } from "./cloud-viewer-types";
import { CloudHomeView } from "./home-view";
import { CloudNotebookListView } from "./notebook-list-view";
import { loadNotebookRouteModule } from "./notebook-route-preload";
import { OidcCallbackView } from "./oidc-callback-view";
import "./index.css";

const NotebookRoute = lazy(() =>
  loadNotebookRouteModule().then((module) => ({ default: module.NotebookRoute })),
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

function App() {
  const [authConfig] = useState<CloudViewerAuthConfig>(() => loadAuthConfig());
  const [runtimeState] = useState<ViewerRuntimeState | null>(() =>
    isOidcCallbackPath() || isHomePath() || isNotebookListPath() ? null : loadViewerRuntime(),
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

  if (isOidcCallbackPath()) {
    return <OidcCallbackView authConfig={authConfig} />;
  }

  if (!runtimeState) {
    return <ViewerStartupError message="Unable to start cloud viewer: missing runtime state" />;
  }
  if (runtimeState.kind === "error") {
    return <ViewerStartupError message={`Unable to start cloud viewer: ${runtimeState.message}`} />;
  }

  return (
    <Suspense fallback={<ViewerStartupLoading />}>
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

function ViewerStartupLoading() {
  return (
    <main className="flex min-h-screen w-full flex-col px-8 py-4 pr-4">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-normal">nteract cloud notebook</h1>
      </header>
      <div className="cloud-state" role="status">
        Loading notebook.
      </div>
    </main>
  );
}

createRoot(requireElement("#root")).render(
  <ErrorBoundary
    fallback={(error) => <ViewerStartupError message={`Cloud viewer crashed: ${error.message}`} />}
  >
    <App />
  </ErrorBoundary>,
);
