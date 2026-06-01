import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { OutputArea } from "../../../../../src/components/cell/OutputArea";
import { ReadOnlyNotebook } from "../../../../../src/components/cell/ReadOnlyNotebook";
import { IsolatedRendererProvider } from "../../../../../src/components/isolated/isolated-renderer-context";
import { MediaProvider } from "../../../../../src/components/outputs/media-provider";
import { ThemeToggle } from "../../../../../src/components/ui/theme-toggle";
import { useWidgetStoreRequired } from "../../../../../src/components/widgets/widget-store-context";
import { useTheme } from "../../../../../src/hooks/useTheme";
import { CLOUD_VIEWER_PRIORITY } from "../../../viewer/mime-policy";
import { applyDocumentTheme, CLOUD_VIEWER_THEME_STORAGE_KEY } from "../../../viewer/theme";
import {
  CLOUD_WIDGET_RENDERERS,
  CloudWidgetStoreProvider,
  projectCloudWidgetComms,
} from "../../../viewer/widget-runtime";
import {
  cloudOutputParityExpectedMarkers,
  cloudOutputParityHostContext,
  cloudOutputParityWidgetComms,
  resolveCloudOutputParityCells,
} from "../../fixtures/cloud-output-parity";
import "../../../viewer/index.css";
import "./style.css";

const rendererBundle = () => import("virtual:isolated-renderer");

function CloudRendererParityHarness() {
  const { theme, setTheme, resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const { store: widgetStore } = useWidgetStoreRequired();
  const projectedWidgetCommIdsRef = useRef(new Set<string>());
  const [cells, setCells] = useState<Awaited<ReturnType<typeof resolveCloudOutputParityCells>>>([]);
  const [error, setError] = useState<string | null>(null);
  const hostContext = useMemo(() => cloudOutputParityHostContext(), []);
  const boundaryOutputs = useMemo(
    () => [...(cells.find((cell) => cell.id === "sift-html-boundary-output")?.outputs ?? [])],
    [cells],
  );

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    void projectCloudWidgetComms(
      widgetStore,
      cloudOutputParityWidgetComms,
      projectedWidgetCommIdsRef,
    ).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [widgetStore]);

  useEffect(() => {
    let cancelled = false;
    resolveCloudOutputParityCells()
      .then((resolvedCells) => {
        if (!cancelled) setCells(resolvedCells);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <main className="cloud-render-parity-page">
        <div data-testid="parity-error">{error}</div>
      </main>
    );
  }

  return (
    <main
      className="cloud-render-parity-page"
      data-testid="cloud-render-parity"
      data-ready={cells.length > 0 ? "true" : "false"}
      data-theme={resolvedTheme}
      data-theme-mode={theme}
    >
      <header className="cloud-render-parity-header">
        <div>
          <p>notebook-cloud</p>
          <h1>Renderer parity fixture</h1>
        </div>
        <div className="cloud-render-parity-actions" aria-label="Theme controls">
          <ThemeToggle theme={theme} onThemeChange={setTheme} />
        </div>
      </header>
      <div data-testid="fixture-markers" hidden>
        {Object.values(cloudOutputParityExpectedMarkers).join("\n")}
      </div>
      <IsolatedRendererProvider loader={rendererBundle}>
        <MediaProvider priority={CLOUD_VIEWER_PRIORITY} renderers={CLOUD_WIDGET_RENDERERS}>
          <ReadOnlyNotebook
            cells={cells}
            priority={CLOUD_VIEWER_PRIORITY}
            hostContext={hostContext}
            className="cloud-render-parity-notebook"
            label="Cloud renderer parity notebook"
          />
          {boundaryOutputs.length > 0 ? (
            <section aria-label="Sift boundary controls" className="cloud-render-parity-boundaries">
              <div data-testid="forced-sift-boundary">
                <h2>Forced isolated Sift boundary</h2>
                <OutputArea
                  cellId="forced-sift-boundary"
                  outputs={boundaryOutputs}
                  isolated
                  priority={CLOUD_VIEWER_PRIORITY}
                  hostContext={hostContext}
                />
              </div>
              <div data-testid="sift-boundary">
                <h2>Sift boundary</h2>
                <OutputArea
                  cellId="sift-boundary"
                  outputs={boundaryOutputs}
                  priority={CLOUD_VIEWER_PRIORITY}
                  hostContext={hostContext}
                />
              </div>
            </section>
          ) : null}
        </MediaProvider>
      </IsolatedRendererProvider>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing root element");
}

createRoot(root).render(
  <StrictMode>
    <CloudWidgetStoreProvider>
      <CloudRendererParityHarness />
    </CloudWidgetStoreProvider>
  </StrictMode>,
);
