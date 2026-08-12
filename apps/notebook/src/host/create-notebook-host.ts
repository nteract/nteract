import type { NotebookHost } from "@nteract/notebook-host";

export function isTauriRuntime(): boolean {
  const w = window as Window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
  return "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}

function electronHostParentOrigin(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get("nteract-host") !== "electron") return null;
  const parentOrigin = params.get("nteract-parent-origin");
  if (!parentOrigin) {
    throw new Error("Electron notebook host requires an exact nteract-parent-origin.");
  }
  return parentOrigin;
}

export async function createNotebookHost(): Promise<NotebookHost> {
  if (isTauriRuntime()) {
    const { createTauriHost } = await import("@nteract/notebook-host/tauri");
    return createTauriHost();
  }

  const parentOrigin = electronHostParentOrigin();
  if (parentOrigin) {
    const { createElectronHost, waitForElectronHostConnection } =
      await import("@nteract/notebook-host/electron");
    const connection = await waitForElectronHostConnection({ parentOrigin });
    return createElectronHost(connection);
  }

  const { createBrowserHost } = await import("@nteract/notebook-host/browser");
  return createBrowserHost();
}
