import { notebookActorIdentityFromRuntime } from "./actor-projection";
import type {
  NotebookShellAccessLevel,
  NotebookShellAccessSource,
  NotebookShellCapabilities,
} from "./capabilities";
import type { NotebookPackageViewModel } from "./view-model";

export type NotebookRuntimeStatus = "ready" | "detached" | "unavailable" | "launching" | "error";
export type NotebookPackageSyncStatus =
  | "synced"
  | "dirty"
  | "not_running"
  | "not_uv_managed"
  | "unavailable"
  | "unknown";
export type NotebookTrustStatus = "trusted" | "untrusted" | "not_required" | "unknown";

export interface NotebookEnvironmentSurface {
  access: {
    level: NotebookShellAccessLevel;
    source: NotebookShellAccessSource;
    label: string;
    sourceLabel: string;
    visibilityLabel: string;
    isPublic: boolean;
  };
  runtime: {
    status: NotebookRuntimeStatus;
    label: string;
    detail: string | null;
    muted: boolean;
  };
  packages: {
    summary: string;
    sourceLabel: string;
    accessLabel: string;
    muted: boolean;
  };
  sync: {
    status: NotebookPackageSyncStatus;
    label: string;
    muted: boolean;
  };
  trust: {
    status: NotebookTrustStatus;
    label: string;
    attention: boolean;
  };
}

export interface CreateNotebookEnvironmentSurfaceOptions {
  capabilities: NotebookShellCapabilities;
  packages: NotebookPackageViewModel;
  runtimeLabel?: string | null;
  runtimeStatus?: NotebookRuntimeStatus | null;
  packageSourceLabel?: string | null;
  syncLabel?: string | null;
  syncStatus?: NotebookPackageSyncStatus | null;
  trustLabel?: string | null;
  trustStatus?: NotebookTrustStatus | null;
}

export function createNotebookEnvironmentSurface({
  capabilities,
  packages,
  runtimeLabel = null,
  runtimeStatus = null,
  packageSourceLabel = null,
  syncLabel = null,
  syncStatus = null,
  trustLabel = null,
  trustStatus = null,
}: CreateNotebookEnvironmentSurfaceOptions): NotebookEnvironmentSurface {
  const packageAccessLabel = capabilities.canManagePackages
    ? "Editable in this notebook"
    : capabilities.canViewPackages
      ? "Read-only in this notebook"
      : "Hidden for this viewer";
  const runtimeStateLabel =
    runtimeLabel ?? (capabilities.canExecute ? "Runtime ready" : "No runtime");
  const runtimeActor = notebookActorIdentityFromRuntime(capabilities.runtime, capabilities.auth);
  const runtimeDetail = capabilities.runtime.canWriteRuntimeState
    ? `${runtimeActor?.label ?? "Connected runtime"} authors runtime state`
    : capabilities.runtime.connected
      ? `Runtime connected through ${accessSourceLabel(capabilities.runtime.source)}`
      : null;

  return {
    access: {
      level: capabilities.access.level,
      source: capabilities.access.source,
      label: accessLevelLabel(capabilities.access.level),
      sourceLabel: accessSourceLabel(capabilities.access.source),
      visibilityLabel: capabilities.access.isPublic ? "Public" : "Private",
      isPublic: capabilities.access.isPublic,
    },
    runtime: {
      status:
        runtimeStatus ??
        (capabilities.canExecute
          ? "ready"
          : capabilities.runtime.connected
            ? "detached"
            : "unavailable"),
      label: runtimeStateLabel,
      detail: runtimeDetail,
      muted: !capabilities.canExecute && !capabilities.runtime.connected,
    },
    packages: {
      summary: packages.summary ?? "No package details",
      sourceLabel: packageSourceLabel ?? packageAccessLabel,
      accessLabel: packageAccessLabel,
      muted: !capabilities.canViewPackages,
    },
    sync: {
      status: syncStatus ?? (syncLabel ? "synced" : "unknown"),
      label: syncLabel ?? "Sync status not reported",
      muted: !syncLabel,
    },
    trust: {
      status:
        trustStatus ??
        (trustLabel?.toLowerCase().includes("untrusted")
          ? "untrusted"
          : trustLabel
            ? "trusted"
            : "not_required"),
      label: trustLabel ?? "Trust state not required",
      attention:
        trustStatus === "untrusted" ||
        trustLabel?.toLowerCase().includes("untrusted") === true ||
        trustLabel?.toLowerCase().includes("attention") === true,
    },
  };
}

export function accessLevelLabel(level: NotebookShellAccessLevel): string {
  switch (level) {
    case "none":
      return "No";
    case "viewer":
      return "Viewer";
    case "editor":
      return "Editor";
    case "owner":
      return "Owner";
  }
}

export function accessSourceLabel(source: NotebookShellAccessSource): string {
  switch (source) {
    case "cloud":
      return "cloud";
    case "local":
      return "local host";
    case "fixture":
      return "fixture";
    case "unknown":
      return "unknown host";
  }
}
