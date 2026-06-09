import type { NotebookPackageViewModel } from "./package-view-model";

export type EnvironmentAccessLevel = "none" | "viewer" | "editor" | "owner";

export type EnvironmentAccessSource = "cloud" | "local" | "fixture" | "unknown";

export type EnvironmentRuntimeStatus = "ready" | "detached" | "unavailable" | "launching" | "error";
export type EnvironmentPackageSyncStatus =
  | "synced"
  | "dirty"
  | "not_running"
  | "not_uv_managed"
  | "unavailable"
  | "unknown";
export type EnvironmentTrustStatus = "trusted" | "untrusted" | "not_required" | "unknown";

export interface EnvironmentRuntimeActor {
  label: string;
  principalLabel?: string | null;
  operatorLabel?: string | null;
}

export interface EnvironmentActorProjectionLike {
  principal?: {
    label?: string | null;
  } | null;
  operator?: {
    label?: string | null;
  } | null;
}

export interface EnvironmentSurfaceCapabilities {
  canExecute: boolean;
  canViewPackages: boolean;
  canManagePackages: boolean;
  access: {
    level: EnvironmentAccessLevel;
    source: EnvironmentAccessSource;
    isPublic: boolean;
  };
  runtime: {
    canWriteRuntimeState: boolean;
    connected: boolean;
    source: EnvironmentAccessSource;
    actorLabel?: string | null;
    identityLabel?: string | null;
    actor?: EnvironmentActorProjectionLike | null;
  };
}

export interface EnvironmentSurface {
  access: {
    level: EnvironmentAccessLevel;
    source: EnvironmentAccessSource;
    label: string;
    sourceLabel: string;
    visibilityLabel: string;
    isPublic: boolean;
  };
  runtime: {
    status: EnvironmentRuntimeStatus;
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
    status: EnvironmentPackageSyncStatus;
    label: string;
    muted: boolean;
  };
  trust: {
    status: EnvironmentTrustStatus;
    label: string;
    attention: boolean;
  };
}

export interface CreateEnvironmentSurfaceOptions {
  capabilities: EnvironmentSurfaceCapabilities;
  packages: NotebookPackageViewModel;
  runtimeLabel?: string | null;
  runtimeStatus?: EnvironmentRuntimeStatus | null;
  packageSourceLabel?: string | null;
  syncLabel?: string | null;
  syncStatus?: EnvironmentPackageSyncStatus | null;
  trustLabel?: string | null;
  trustStatus?: EnvironmentTrustStatus | null;
}

export function createEnvironmentSurface({
  capabilities,
  packages,
  runtimeLabel = null,
  runtimeStatus = null,
  packageSourceLabel = null,
  syncLabel = null,
  syncStatus = null,
  trustLabel = null,
  trustStatus = null,
}: CreateEnvironmentSurfaceOptions): EnvironmentSurface {
  const packageAccessLabel = capabilities.canManagePackages
    ? "Editable in this notebook"
    : capabilities.canViewPackages
      ? "Read-only in this notebook"
      : "Hidden for this viewer";
  const runtimeStateLabel =
    runtimeLabel ?? (capabilities.canExecute ? "Runtime ready" : "No runtime");
  const runtimeActor = environmentRuntimeActorFromCapabilities(capabilities.runtime);
  const runtimeDetail = capabilities.runtime.canWriteRuntimeState
    ? runtimeStateReporterDetail(runtimeActor)
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

export function accessLevelLabel(level: EnvironmentAccessLevel): string {
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

export function accessSourceLabel(source: EnvironmentAccessSource): string {
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

function environmentRuntimeActorFromCapabilities(
  runtime: EnvironmentSurfaceCapabilities["runtime"],
): EnvironmentRuntimeActor | null {
  if (runtime.actor) {
    const principalLabel = runtime.actor.principal?.label ?? runtime.identityLabel ?? null;
    const operatorLabel = runtime.actor.operator?.label ?? null;
    return {
      label: operatorLabel ?? principalLabel ?? "Runtime",
      principalLabel,
      operatorLabel,
    };
  }

  if (!runtime.connected && !runtime.actorLabel) {
    return null;
  }

  const parsed = parseRuntimeActorLabel(runtime.actorLabel);
  return {
    label: parsed.operatorLabel ?? parsed.principalLabel ?? runtime.identityLabel ?? "Runtime",
    principalLabel: runtime.identityLabel ?? parsed.principalLabel,
    operatorLabel: parsed.operatorLabel,
  };
}

function parseRuntimeActorLabel(actorLabel: string | null | undefined): EnvironmentRuntimeActor {
  if (!actorLabel) {
    return { label: "Runtime", principalLabel: null, operatorLabel: null };
  }

  const [principalId, operatorId] = actorLabel.split("/");
  const principalLabel = friendlyActorSegment(principalId, "Runtime principal");
  const operatorLabel = friendlyActorSegment(operatorId, "Runtime");

  return {
    label: operatorLabel,
    principalLabel,
    operatorLabel,
  };
}

function friendlyActorSegment(segment: string | null | undefined, fallback: string): string {
  const value = segment?.split(":").filter(Boolean).at(-1);
  if (!value) return fallback;
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function runtimeStateReporterDetail(actor: EnvironmentRuntimeActor | null): string {
  if (!actor) return "Connected runtime reports runtime state";
  if (actor.operatorLabel && actor.principalLabel && actor.operatorLabel !== actor.principalLabel) {
    return `${actor.operatorLabel} reports runtime state for ${actor.principalLabel}`;
  }
  return `${actor.label} reports runtime state`;
}

export type NotebookRuntimeStatus = EnvironmentRuntimeStatus;
export type NotebookPackageSyncStatus = EnvironmentPackageSyncStatus;
export type NotebookTrustStatus = EnvironmentTrustStatus;
export type NotebookEnvironmentSurface = EnvironmentSurface;
export type CreateNotebookEnvironmentSurfaceOptions = CreateEnvironmentSurfaceOptions;
export const createNotebookEnvironmentSurface = createEnvironmentSurface;
