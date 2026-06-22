let notebookRouteModulePromise: Promise<typeof import("./notebook-route")> | null = null;

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
