import type { NotebookHost } from "@nteract/notebook-host";

export function isTauriRuntime(): boolean {
  const w = window as Window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
  return "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}

export async function createNotebookHost(): Promise<NotebookHost> {
  if (isTauriRuntime()) {
    const { createTauriHost } = await import("@nteract/notebook-host/tauri");
    return createTauriHost();
  }

  const { createBrowserHost } = await import("@nteract/notebook-host/browser");
  return createBrowserHost();
}
