export function hostedNotebookWindowTitle(locator: string): string {
  try {
    const url = new URL(locator);
    const segments = url.pathname.split("/");
    const notebookId = segments[1] === "n" ? segments[2] : undefined;
    if (!notebookId) return "Cloud Notebook";
    return `${notebookId} · ${url.host}`;
  } catch {
    return "Cloud Notebook";
  }
}
