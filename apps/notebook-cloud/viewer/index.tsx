import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BookOpen, House, Loader2 } from "lucide-react";
import { ErrorBoundary } from "@/lib/error-boundary";
import { setLoggerHost } from "@/lib/logger";
import { setOpenUrlHost } from "@/lib/open-url";
import { installDocumentThemeSync } from "./theme";
import {
  isHomePath,
  isMarkdownDocumentListPath,
  isMarkdownDocumentRoutePath,
  isNotebookListPath,
  isOidcCallbackPath,
  loadAuthConfig,
  loadMarkdownDocumentConfig,
  loadViewerRuntime,
  requireElement,
} from "./cloud-viewer-config";
import type { CloudViewerAuthConfig, ViewerRuntimeState } from "./cloud-viewer-types";
import { cloudNotebookRouteTitleFromPathname } from "./cloud-notebook-title-state";
import { CloudHomeView } from "./home-view";
import { CLOUD_VIEWER_ROUTE_CHANGE_EVENT } from "./cloud-viewer-navigation";
import { CloudMarkdownDocumentListView } from "./markdown-document-list-view";
import { CloudNotebookListView } from "./notebook-list-view";
import { loadNotebookRouteModule } from "./notebook-route-preload";
import { OidcCallbackView } from "./oidc-callback-view";
import "./index.css";

const MarkdownDocumentRoute = lazy(() =>
  import("./markdown-document-route").then((module) => ({
    default: module.MarkdownDocumentRoute,
  })),
);

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
  const [locationHref, setLocationHref] = useState(() => window.location.href);
  const pathname = new URL(locationHref).pathname;
  const [authConfig] = useState<CloudViewerAuthConfig>(() => loadAuthConfig());
  const [runtimeState] = useState<ViewerRuntimeState | null>(() =>
    isOidcCallbackPath(pathname) ||
    isHomePath(pathname) ||
    isNotebookListPath(pathname) ||
    isMarkdownDocumentListPath(pathname)
      ? null
      : isMarkdownDocumentRoutePath(pathname)
        ? null
        : loadViewerRuntime(),
  );
  const [markdownConfig] = useState(() =>
    isMarkdownDocumentRoutePath(pathname) ? loadMarkdownDocumentConfig() : null,
  );

  useEffect(() => {
    const updateLocation = () => setLocationHref(window.location.href);
    window.addEventListener("popstate", updateLocation);
    window.addEventListener(CLOUD_VIEWER_ROUTE_CHANGE_EVENT, updateLocation);
    return () => {
      window.removeEventListener("popstate", updateLocation);
      window.removeEventListener(CLOUD_VIEWER_ROUTE_CHANGE_EVENT, updateLocation);
    };
  }, []);

  if (isHomePath(pathname)) {
    // The Worker currently redirects / and /index.html to /n. Keep this route
    // mounted for the temporary redirect's rollback path and future home-page
    // experiments that may serve the viewer shell directly again.
    return <CloudHomeView authConfig={authConfig} />;
  }

  if (isNotebookListPath(pathname)) {
    return <CloudNotebookListView authConfig={authConfig} />;
  }

  if (isMarkdownDocumentListPath(pathname)) {
    return <CloudMarkdownDocumentListView authConfig={authConfig} />;
  }

  if (isOidcCallbackPath(pathname)) {
    return <OidcCallbackView authConfig={authConfig} />;
  }

  if (isMarkdownDocumentRoutePath(pathname)) {
    if (!markdownConfig) {
      return <ViewerStartupError message="Unable to start Markdown document: missing config" />;
    }
    return (
      <Suspense
        fallback={
          <ViewerStartupLoading
            title={markdownDocumentStartupTitle(markdownConfig)}
            status="Loading"
            homeHref="/m"
            homeAriaLabel="Open Markdown documents"
          />
        }
      >
        <MarkdownDocumentRoute config={markdownConfig} authConfig={authConfig} />
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

function ViewerStartupLoading({
  homeAriaLabel = "Open notebooks dashboard",
  homeHref = "/n",
  status = "Opening notebook",
  title,
}: {
  homeAriaLabel?: string;
  homeHref?: string;
  status?: string;
  title: string;
}) {
  return (
    <main className="cloud-startup-shell" aria-busy="true">
      <header className="cloud-startup-toolbar">
        <div className="cloud-notebook-title-group">
          <a className="cloud-notebook-home-link" href={homeHref} aria-label={homeAriaLabel}>
            <House aria-hidden="true" />
          </a>
          <div className="cloud-notebook-title">
            <h1 className="cloud-startup-title">{title}</h1>
            <p className="cloud-startup-status" role="status">
              <Loader2 aria-hidden="true" />
              {status}
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

function markdownDocumentStartupTitle(
  config: ReturnType<typeof loadMarkdownDocumentConfig> | null,
): string {
  return config?.bootstrap?.title?.trim() || "Markdown document";
}

createRoot(requireElement("#root")).render(
  <ErrorBoundary
    fallback={(error) => <ViewerStartupError message={`Cloud viewer crashed: ${error.message}`} />}
  >
    <App />
  </ErrorBoundary>,
);
