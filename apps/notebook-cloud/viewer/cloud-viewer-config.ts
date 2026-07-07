import { isCloudAppSession } from "./app-session";
import type { CloudRendererAssetNames, CloudViewerConfig } from "./cloud-viewer-session";
import {
  isCloudNotebookListItem,
  isOptionalCloudNotebookListTotalCount,
} from "./notebook-dashboard";
import { normalizeOidcAuthConfig, type CloudOidcAuthConfig } from "./oidc-auth";
import type {
  CloudNotebookListBootstrap,
  CloudViewerAuthConfig,
  CloudViewerLocalDevAuthConfig,
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
    authorProfilesEndpoint:
      typeof parsed.authorProfilesEndpoint === "string" ? parsed.authorProfilesEndpoint : undefined,
    workstationsEndpoint: parsed.workstationsEndpoint,
    workstationDefaultEndpoint: parsed.workstationDefaultEndpoint,
    workstationAttachEndpoint: parsed.workstationAttachEndpoint,
    hostCapabilities: {
      canManageSharing: Boolean(parsed.hostCapabilities?.canManageSharing),
      canSubmitExecutionRequests: Boolean(parsed.hostCapabilities?.canSubmitExecutionRequests),
    },
    featureFlags: {
      enable_comments: parsed.featureFlags?.enable_comments === true,
      disable_auto_format: parsed.featureFlags?.disable_auto_format === true,
    },
    initialCatalogAccess: normalizeInitialCatalogAccess(parsed.initialCatalogAccess),
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

function normalizeInitialCatalogAccess(
  value: CloudViewerConfig["initialCatalogAccess"] | undefined,
): CloudViewerConfig["initialCatalogAccess"] {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (value.scope !== "viewer" && value.scope !== "editor" && value.scope !== "owner") {
    return null;
  }
  return {
    scope: value.scope,
    title: typeof value.title === "string" || value.title === null ? value.title : undefined,
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
    return { oidc: null, localDev: null };
  }
  try {
    const parsed = JSON.parse(element.textContent ?? "{}") as {
      localDev?: Partial<CloudViewerLocalDevAuthConfig> | null;
      oidc?: Partial<CloudOidcAuthConfig> | null;
    };
    return {
      oidc: normalizeOidcAuthConfig(parsed.oidc),
      localDev: normalizeLocalDevAuthConfig(parsed.localDev),
    };
  } catch {
    return { oidc: null, localDev: null };
  }
}

function normalizeLocalDevAuthConfig(
  input: Partial<CloudViewerLocalDevAuthConfig> | null | undefined,
): CloudViewerLocalDevAuthConfig | null {
  const rawAuthUrl = input?.authUrl?.trim();
  if (!rawAuthUrl) {
    return null;
  }
  try {
    const authUrl = new URL(rawAuthUrl, window.location.origin);
    if (authUrl.origin !== window.location.origin) {
      return null;
    }
    const label = input?.label?.trim();
    return {
      authUrl: `${authUrl.pathname}${authUrl.search}${authUrl.hash}`,
      ...(label ? { label } : {}),
    };
  } catch {
    return null;
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

export function isWorkstationsPath(): boolean {
  return window.location.pathname.replace(/\/+$/, "") === "/workstations";
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
    isOptionalCloudNotebookListTotalCount(candidate.total_count, candidate.notebooks.length) &&
    (candidate.session === undefined ||
      candidate.session === null ||
      isCloudAppSession(candidate.session))
  );
}
