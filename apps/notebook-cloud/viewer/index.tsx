import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import { MediaProvider } from "@/components/outputs/media-provider";
import { ErrorBoundary } from "@/lib/error-boundary";
import { setLoggerHost, setOpenUrlHost } from "../../notebook/src/notebook-surface";
import { rendererAssetBasePathForProvider } from "./renderer-assets";
import { loadSupplementalViewerCss } from "./supplemental-css";
import { installDocumentThemeSync } from "./theme";
import { CLOUD_WIDGET_RENDERERS, CloudWidgetStoreProvider } from "./widget-runtime";
import { CLOUD_VIEWER_PRIORITY } from "./mime-policy";
import {
  isHomePath,
  isNotebookListPath,
  isOidcCallbackPath,
  loadAuthConfig,
  loadViewerRuntime,
  requireElement,
} from "./cloud-viewer-config";
import type { CloudViewerConfig } from "./cloud-viewer-session";
import type { CloudViewerAuthConfig, ViewerRuntimeState } from "./cloud-viewer-types";
import { CloudHomeView } from "./home-view";
import { CloudNotebookListView } from "./notebook-list-view";
import { OidcCallbackView } from "./oidc-callback-view";
import { NotebookViewer } from "./notebook-viewer";
import "./index.css";

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
    <CloudNotebookProviders config={runtimeState.runtime.config}>
      <NotebookViewer runtime={runtimeState.runtime} authConfig={authConfig} />
    </CloudNotebookProviders>
  );
}

function CloudNotebookProviders({
  children,
  config,
}: {
  children: ReactNode;
  config: CloudViewerConfig;
}) {
  useEffect(() => {
    loadSupplementalViewerCss();
  }, []);

  // Manifest filenames (content-hashed when deployed) keep the renderer
  // bundle on the asset origin's immutable cache path; the stable names
  // remain the fallback for shells without manifest names.
  const rendererAssetNames = useMemo(
    () => ({ js: config.rendererAssets.js, css: config.rendererAssets.css }),
    [config.rendererAssets.css, config.rendererAssets.js],
  );

  return (
    <IsolatedRendererProvider
      basePath={rendererAssetBasePathForProvider(config.rendererAssetsBasePath)}
      assetNames={rendererAssetNames}
    >
      <CloudWidgetStoreProvider>
        <MediaProvider priority={CLOUD_VIEWER_PRIORITY} renderers={CLOUD_WIDGET_RENDERERS}>
          {children}
        </MediaProvider>
      </CloudWidgetStoreProvider>
    </IsolatedRendererProvider>
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

createRoot(requireElement("#root")).render(
  <ErrorBoundary
    fallback={(error) => <ViewerStartupError message={`Cloud viewer crashed: ${error.message}`} />}
  >
    <App />
  </ErrorBoundary>,
);
