import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReadOnlyNotebook } from "../../../../../src/components/cell/ReadOnlyNotebook";
import { IsolatedRendererProvider } from "../../../../../src/components/isolated/isolated-renderer-context";
import { MediaProvider } from "../../../../../src/components/outputs/media-provider";
import { CLOUD_VIEWER_PRIORITY } from "../../../viewer/mime-policy";
import {
  cloudOutputParityExpectedMarkers,
  cloudOutputParityHostContext,
  resolveCloudOutputParityCells,
} from "../../fixtures/cloud-output-parity";
import "../../../viewer/index.css";
import "./style.css";

const rendererBundle = () => import("virtual:isolated-renderer");

type ThemeMode = "light" | "dark";

function applyTheme(theme: ThemeMode): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.classList.toggle("light", theme === "light");
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function CloudRendererParityHarness() {
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [cells, setCells] = useState<Awaited<ReturnType<typeof resolveCloudOutputParityCells>>>([]);
  const [error, setError] = useState<string | null>(null);
  const hostContext = useMemo(() => cloudOutputParityHostContext(), []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

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
      data-theme={theme}
    >
      <header className="cloud-render-parity-header">
        <div>
          <p>notebook-cloud</p>
          <h1>Renderer parity fixture</h1>
        </div>
        <div className="cloud-render-parity-actions" aria-label="Theme controls">
          <button
            type="button"
            data-testid="theme-light"
            data-active={theme === "light" ? "true" : "false"}
            onClick={() => setTheme("light")}
          >
            Light
          </button>
          <button
            type="button"
            data-testid="theme-dark"
            data-active={theme === "dark" ? "true" : "false"}
            onClick={() => setTheme("dark")}
          >
            Dark
          </button>
        </div>
      </header>
      <div data-testid="fixture-markers" hidden>
        {Object.values(cloudOutputParityExpectedMarkers).join("\n")}
      </div>
      <IsolatedRendererProvider loader={rendererBundle}>
        <MediaProvider priority={CLOUD_VIEWER_PRIORITY}>
          <ReadOnlyNotebook
            cells={cells}
            priority={CLOUD_VIEWER_PRIORITY}
            hostContext={hostContext}
            className="cloud-render-parity-notebook"
            label="Cloud renderer parity notebook"
          />
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
    <CloudRendererParityHarness />
  </StrictMode>,
);
