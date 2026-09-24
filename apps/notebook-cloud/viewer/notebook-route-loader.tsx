import { useEffect, useState } from "react";
import type { CloudViewerAuthConfig, ViewerRuntime } from "./cloud-viewer-types";
import { cloudNotebookRouteTitleFromPathname } from "./cloud-notebook-title-state";
import { loadNotebookRouteModule } from "./notebook-route-preload";
import { loadRouteWithRecovery } from "./route-load-recovery";
import { ViewerStartupLoading } from "./viewer-startup-loading";

type RouteState =
  | { kind: "loading" }
  | { kind: "ready"; module: Awaited<ReturnType<typeof loadNotebookRouteModule>> }
  | { kind: "error"; error: unknown };

/** Mount the downloaded route immediately, without Suspense's fallback delay. */
export function NotebookRouteLoader({
  runtime,
  authConfig,
}: {
  runtime: ViewerRuntime;
  authConfig: CloudViewerAuthConfig;
}) {
  const [route, setRoute] = useState<RouteState>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    void loadRouteWithRecovery(loadNotebookRouteModule).then(
      (module) => {
        if (active) setRoute({ kind: "ready", module });
      },
      (error: unknown) => {
        if (active) setRoute({ kind: "error", error });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (route.kind === "error") throw route.error;
  if (route.kind === "ready") {
    return <route.module.NotebookRoute runtime={runtime} authConfig={authConfig} />;
  }
  return (
    <ViewerStartupLoading
      title={cloudNotebookRouteTitleFromPathname(window.location.pathname).title}
    />
  );
}
