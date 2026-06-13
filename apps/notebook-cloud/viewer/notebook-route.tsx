import { useEffect, useMemo, type ReactNode } from "react";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import { MediaProvider } from "@/components/outputs/media-provider";
import type { CloudViewerConfig } from "./cloud-viewer-session";
import type { CloudViewerAuthConfig, ViewerRuntime } from "./cloud-viewer-types";
import { CLOUD_VIEWER_PRIORITY } from "./mime-policy";
import { NotebookViewer } from "./notebook-viewer";
import { rendererAssetBasePathForProvider } from "./renderer-assets";
import { loadSupplementalViewerCss } from "./supplemental-css";
import { CLOUD_WIDGET_RENDERERS, CloudWidgetStoreProvider } from "./widget-runtime";

export function NotebookRoute({
  authConfig,
  runtime,
}: {
  authConfig: CloudViewerAuthConfig;
  runtime: ViewerRuntime;
}) {
  return (
    <CloudNotebookProviders config={runtime.config}>
      <NotebookViewer runtime={runtime} authConfig={authConfig} />
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
