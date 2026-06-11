import { isCloudAppSession } from "./app-session";
import type { CloudRendererAssetNames, CloudViewerConfig } from "./cloud-viewer-session";
import { isCloudNotebookListItem } from "./notebook-dashboard";
import { normalizeOidcAuthConfig, type CloudOidcAuthConfig } from "./oidc-auth";
import type {
  CloudNotebookListBootstrap,
  CloudViewerAuthConfig,
  ViewerRuntimeState,
} from "./cloud-viewer-types";

export function requireElement<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing cloud viewer element ${selector}`);
  }
  return element;
}

function loadConfig(): CloudViewerConfig {
  const element = requireElement<HTMLScriptElement>("#nteract-cloud-viewer-config");
  const parsed = JSON.parse(element.textContent ?? "{}") as Partial<CloudViewerConfig>;
  if (
    !parsed.notebookId ||
    !parsed.catalogEndpoint ||
    !parsed.snapshotBasePath ||
    !parsed.runtimeSnapshotBasePath ||
    !parsed.commsSnapshotBasePath ||
    !parsed.aclEndpoint ||
    !parsed.invitesEndpoint ||
    !parsed.accessRequestsEndpoint ||
    !parsed.workstationsEndpoint ||
    !parsed.workstationDefaultEndpoint ||
    !parsed.workstationAttachEndpoint ||
    !parsed.syncEndpoint ||
    !parsed.blobBasePath ||
    !parsed.rendererAssetsBasePath ||
    !parsed.runtimedWasmModulePath ||
    !parsed.runtimedWasmPath
  ) {
    throw new Error("Cloud viewer config is incomplete");
  }
  return {
    notebookId: parsed.notebookId,
    headsHash: parsed.headsHash ?? null,
    catalogEndpoint: parsed.catalogEndpoint,
    snapshotBasePath: parsed.snapshotBasePath,
    runtimeSnapshotBasePath: parsed.runtimeSnapshotBasePath,
    commsSnapshotBasePath: parsed.commsSnapshotBasePath,
    aclEndpoint: parsed.aclEndpoint,
    invitesEndpoint: parsed.invitesEndpoint,
    accessRequestsEndpoint: parsed.accessRequestsEndpoint,
    workstationsEndpoint: parsed.workstationsEndpoint,
    workstationDefaultEndpoint: parsed.workstationDefaultEndpoint,
    workstationAttachEndpoint: parsed.workstationAttachEndpoint,
    hostCapabilities: {
      canManageSharing: Boolean(parsed.hostCapabilities?.canManageSharing),
      canSubmitExecutionRequests: Boolean(parsed.hostCapabilities?.canSubmitExecutionRequests),
    },
    session: isCloudAppSession(parsed.session) ? parsed.session : null,
    syncEndpoint: parsed.syncEndpoint,
    blobBasePath: parsed.blobBasePath,
    rendererAssetsBasePath: parsed.rendererAssetsBasePath,
    rendererAssets: normalizeRendererAssetNames(parsed.rendererAssets),
    outputDocumentBaseUrl: parsed.outputDocumentBaseUrl ?? null,
    runtimedWasmModulePath: parsed.runtimedWasmModulePath,
    runtimedWasmPath: parsed.runtimedWasmPath,
  };
}

const STABLE_RENDERER_ASSET_NAMES: CloudRendererAssetNames = {
  js: "isolated-renderer.js",
  css: "isolated-renderer.css",
  siftWasm: "sift_wasm.wasm",
};

/**
 * Shells without manifest names (older workers, missing manifest) keep
 * loading the stable-name copies — the documented fallback. The viewer
 * bundle ships under a stable name, so NEW viewer JS routinely executes
 * against OLD shell config during gradual worker deploys; this guard is
 * that skew's client half and must stay tolerant of an absent key.
 */
export function normalizeRendererAssetNames(
  value: Partial<CloudRendererAssetNames> | undefined,
): CloudRendererAssetNames {
  return {
    js: value?.js || STABLE_RENDERER_ASSET_NAMES.js,
    css: value?.css || STABLE_RENDERER_ASSET_NAMES.css,
    siftWasm: value?.siftWasm || STABLE_RENDERER_ASSET_NAMES.siftWasm,
  };
}

export function loadViewerRuntime(): ViewerRuntimeState {
  try {
    const config = loadConfig();
    return {
      kind: "ready",
      runtime: { config },
    };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function loadAuthConfig(): CloudViewerAuthConfig {
  const element = document.querySelector<HTMLScriptElement>("#nteract-cloud-auth-config");
  if (!element) {
    return { oidc: null };
  }
  try {
    const parsed = JSON.parse(element.textContent ?? "{}") as {
      oidc?: Partial<CloudOidcAuthConfig> | null;
    };
    return { oidc: normalizeOidcAuthConfig(parsed.oidc) };
  } catch {
    return { oidc: null };
  }
}

export function loadCloudNotebookListBootstrap(): CloudNotebookListBootstrap | null {
  const element = document.querySelector<HTMLScriptElement>("#nteract-cloud-bootstrap");
  if (!element) {
    return null;
  }
  try {
    const parsed = JSON.parse(element.textContent ?? "{}") as unknown;
    if (isCloudNotebookListBootstrap(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

export function isOidcCallbackPath(): boolean {
  return window.location.pathname.replace(/\/+$/, "") === "/oidc";
}

export function isHomePath(): boolean {
  const pathname = window.location.pathname.replace(/\/+$/, "");
  return pathname === "" || pathname === "/index.html";
}

export function isNotebookListPath(): boolean {
  return window.location.pathname.replace(/\/+$/, "") === "/n";
}

function isCloudNotebookListBootstrap(value: unknown): value is CloudNotebookListBootstrap {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CloudNotebookListBootstrap>;
  return (
    candidate.kind === "notebook-list" &&
    typeof candidate.saved_at === "string" &&
    Array.isArray(candidate.notebooks) &&
    candidate.notebooks.every(isCloudNotebookListItem) &&
    (candidate.session === undefined ||
      candidate.session === null ||
      isCloudAppSession(candidate.session))
  );
}
