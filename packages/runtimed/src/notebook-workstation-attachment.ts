import type { WorkstationAttachmentState } from "./runtime-state";

export type NotebookWorkstationAttachmentClaimStatus =
  | "pending"
  | "accepted"
  | "running"
  | "failed"
  | "completed"
  | "cancelled";

export interface NotebookWorkstationAttachmentClaim {
  errorMessage?: string | null;
  runtimeSessionId?: string | null;
  status: NotebookWorkstationAttachmentClaimStatus;
  updatedAt?: string | null;
}

export interface NotebookWorkstationAttachmentTarget {
  cpuCount?: number | null;
  defaultEnvironmentLabel?: string | null;
  displayName: string;
  environmentPolicy?: string | null;
  memoryBytes?: number | null;
  provider?: string | null;
  workingDirectory?: string | null;
  workstationId: string;
}

export interface ProjectNotebookWorkstationAttachmentFromClaimOptions {
  claim: NotebookWorkstationAttachmentClaim;
  workstation: NotebookWorkstationAttachmentTarget;
}

export function projectNotebookWorkstationAttachmentFromClaim({
  claim,
  workstation,
}: ProjectNotebookWorkstationAttachmentFromClaimOptions): WorkstationAttachmentState {
  return {
    workstation_id: workstation.workstationId,
    display_name: workstation.displayName,
    provider: workstation.provider || "runtime_peer",
    default_environment_label: workstation.defaultEnvironmentLabel ?? "Current Python",
    environment_policy: workstation.environmentPolicy ?? "runtime_peer",
    status: workstationAttachmentStatusForClaim(claim.status),
    status_message: workstationAttachmentStatusMessageForClaim(claim, workstation),
    cpu_count: workstation.cpuCount ?? null,
    memory_bytes: workstation.memoryBytes ?? null,
    working_directory: workstation.workingDirectory ?? null,
    updated_at: claim.updatedAt ?? null,
    runtime_session_id: claim.runtimeSessionId ?? null,
  };
}

function workstationAttachmentStatusForClaim(
  status: NotebookWorkstationAttachmentClaimStatus,
): string {
  switch (status) {
    case "accepted":
      return "connecting";
    case "running":
      return "ready";
    case "failed":
      return "error";
    case "cancelled":
    case "completed":
      return "disconnected";
    case "pending":
      return "connecting";
  }
}

function workstationAttachmentStatusMessageForClaim(
  claim: NotebookWorkstationAttachmentClaim,
  workstation: NotebookWorkstationAttachmentTarget,
): string | null {
  const displayName = workstation.displayName || "Selected workstation";
  switch (claim.status) {
    case "accepted":
      return `${displayName} accepted the request and is starting compute.`;
    case "failed":
      return claim.errorMessage ?? `${displayName} could not start compute for this notebook.`;
    case "cancelled":
      return `${displayName} cancelled the compute request.`;
    case "completed":
      return `${displayName} runtime peer disconnected.`;
    case "pending":
      return `Waiting for ${displayName} to accept the compute request.`;
    case "running":
      return null;
  }
}
