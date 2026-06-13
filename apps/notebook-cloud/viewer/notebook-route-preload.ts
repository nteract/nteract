let notebookRouteModulePromise: Promise<typeof import("./notebook-route")> | null = null;
let scheduledNotebookRoutePreload = false;

export function loadNotebookRouteModule(): Promise<typeof import("./notebook-route")> {
  if (!notebookRouteModulePromise) {
    notebookRouteModulePromise = import("./notebook-route").catch((error: unknown) => {
      notebookRouteModulePromise = null;
      throw error;
    });
  }
  return notebookRouteModulePromise;
}

export function preloadNotebookRoute(): void {
  void loadNotebookRouteModule().catch((error: unknown) => {
    console.warn("[notebook-cloud] notebook route preload failed", error);
  });
}

export function scheduleNotebookRoutePreload(): void {
  if (scheduledNotebookRoutePreload || notebookRouteModulePromise) {
    return;
  }
  if (typeof window === "undefined") {
    return;
  }
  scheduledNotebookRoutePreload = true;

  const load = () => preloadNotebookRoute();
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(load, { timeout: 1500 });
    return;
  }

  setTimeout(load, 750);
}
