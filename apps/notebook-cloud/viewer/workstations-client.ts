import type { NotebookRegisteredWorkstation } from "runtimed";

import { fetchWithCloudPrototypeAuth, type CloudPrototypeAuthState } from "./collaborator-auth";

export interface CloudWorkstationsState {
  defaultWorkstationId: string | null;
  workstations: readonly NotebookRegisteredWorkstation[];
}

export type CloudWorkstationRegistryMutationKind = "idle" | "default" | "attach";

export interface CloudWorkstationRefreshCadenceOptions {
  canChooseHostedWorkstation: boolean;
  hasRegisteredWorkstations: boolean;
  mutationKind: CloudWorkstationRegistryMutationKind;
  panelIsOpen: boolean;
}

export const CLOUD_WORKSTATIONS_ACTIVE_REFRESH_INTERVAL_MS = 10_000;
export const CLOUD_WORKSTATIONS_ATTACH_REFRESH_INTERVAL_MS = 2_500;
export const CLOUD_WORKSTATION_DEBIAN_PREP_COMMAND =
  "sudo apt update && sudo apt install -y curl tmux";
export const CLOUD_WORKSTATION_HEADLESS_INSTALL_COMMAND =
  "curl --proto '=https' --tlsv1.2 -sSf https://sh.nteract.io | bash -s -- --headless";
export const CLOUD_WORKSTATION_PATH_EXPORT_COMMAND = 'export PATH="$HOME/.local/bin:$PATH"';

export interface CloudWorkstationPairingCommand {
  id: string;
  label: string;
  command: string;
  optional?: boolean;
}

interface CloudWorkstationsResponse {
  default_workstation_id?: unknown;
  workstations?: unknown;
}

interface CloudWorkstationAttachmentResponse {
  job?: {
    job_id?: unknown;
    workstation_id?: unknown;
    status?: unknown;
  };
  workstation?: {
    workstation_id?: unknown;
  };
}

export interface RequestCloudWorkstationAttachmentOptions {
  replaceExisting?: boolean;
}

export interface CloudWorkstationAttachmentRequestResult {
  jobId: string | null;
  status: string | null;
  workstationId: string | null;
}

export async function fetchCloudWorkstations(
  endpoint: string,
  authState: CloudPrototypeAuthState,
  signal?: AbortSignal,
): Promise<CloudWorkstationsState> {
  const response = await fetchWithCloudPrototypeAuth(
    endpoint,
    {
      headers: { Accept: "application/json" },
      signal,
    },
    authState,
  );
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, "Unable to load workstations"));
  }
  const payload = (await response.json()) as CloudWorkstationsResponse;
  const workstations = Array.isArray(payload.workstations)
    ? payload.workstations.map(normalizeCloudWorkstation).filter(isNotebookRegisteredWorkstation)
    : [];
  return {
    defaultWorkstationId: scalarString(payload.default_workstation_id),
    workstations,
  };
}

export async function setCloudDefaultWorkstation(
  endpoint: string,
  authState: CloudPrototypeAuthState,
  workstationId: string,
): Promise<string | null> {
  const response = await fetchWithCloudPrototypeAuth(
    endpoint,
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workstation_id: workstationId }),
    },
    authState,
  );
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, "Unable to set default workstation"));
  }
  const payload = (await response.json()) as { default_workstation_id?: unknown };
  return scalarString(payload.default_workstation_id);
}

export async function requestCloudWorkstationAttachment(
  endpoint: string,
  authState: CloudPrototypeAuthState,
  workstationId: string,
  options: RequestCloudWorkstationAttachmentOptions = {},
): Promise<CloudWorkstationAttachmentRequestResult> {
  const response = await fetchWithCloudPrototypeAuth(
    endpoint,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workstation_id: workstationId,
        ...(options.replaceExisting ? { replace_existing: true, intent: "restart" } : {}),
      }),
    },
    authState,
  );
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, "Unable to attach workstation"));
  }
  const payload = (await response.json()) as CloudWorkstationAttachmentResponse;
  return {
    jobId: scalarString(payload.job?.job_id),
    status: scalarString(payload.job?.status),
    workstationId:
      scalarString(payload.job?.workstation_id) ??
      scalarString(payload.workstation?.workstation_id),
  };
}

export type CloudWorkstationPairingStatus = "pending" | "redeemed" | "registered" | "expired";

export interface MintedCloudWorkstationPairing {
  id: string;
  code: string;
  expiresAt: string;
}

export interface CloudWorkstationPairingStatusState {
  status: CloudWorkstationPairingStatus;
  expiresAt: string | null;
  workstationId: string | null;
}

export const CLOUD_WORKSTATION_PAIRING_POLL_INTERVAL_MS = 2_000;

export async function mintCloudWorkstationPairingCode(
  workstationsEndpoint: string,
  authState: CloudPrototypeAuthState,
): Promise<MintedCloudWorkstationPairing> {
  const response = await fetchWithCloudPrototypeAuth(
    `${workstationsEndpoint}/pairing-codes`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
    authState,
  );
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, "Unable to create a pairing code"));
  }
  const payload = (await response.json()) as { pairing?: Record<string, unknown> };
  const id = scalarString(payload.pairing?.id);
  const code = scalarString(payload.pairing?.code);
  const expiresAt = scalarString(payload.pairing?.expires_at);
  if (!id || !code || !expiresAt) {
    throw new Error("Pairing code response was incomplete");
  }
  return { id, code, expiresAt };
}

export async function fetchCloudWorkstationPairingStatus(
  workstationsEndpoint: string,
  authState: CloudPrototypeAuthState,
  pairingId: string,
  signal?: AbortSignal,
): Promise<CloudWorkstationPairingStatusState> {
  const response = await fetchWithCloudPrototypeAuth(
    `${workstationsEndpoint}/pairing-codes/${encodeURIComponent(pairingId)}`,
    {
      headers: { Accept: "application/json" },
      signal,
    },
    authState,
  );
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, "Unable to check pairing status"));
  }
  const payload = (await response.json()) as { pairing?: Record<string, unknown> };
  const status = payload.pairing?.status;
  return {
    status:
      status === "pending" || status === "redeemed" || status === "registered" ? status : "expired",
    expiresAt: scalarString(payload.pairing?.expires_at),
    workstationId: scalarString(payload.pairing?.workstation_id),
  };
}

export function cloudWorkstationConnectCommand(origin: string, code: string): string {
  return `runt workstation connect ${origin} --code ${code}`;
}

export function cloudWorkstationRunCommand(): string {
  return "runt workstation run";
}

export function cloudWorkstationServiceInstallCommand(): string {
  return "runt workstation service install --start";
}

export function cloudWorkstationPairingCommands(
  origin: string,
  code: string,
): readonly CloudWorkstationPairingCommand[] {
  return [
    {
      id: "debian-prep",
      label: "Fresh Debian/Ubuntu only",
      command: CLOUD_WORKSTATION_DEBIAN_PREP_COMMAND,
      optional: true,
    },
    {
      id: "install",
      label: "Install nteract headless",
      command: CLOUD_WORKSTATION_HEADLESS_INSTALL_COMMAND,
    },
    {
      id: "path",
      label: "Use installed CLI in this shell",
      command: CLOUD_WORKSTATION_PATH_EXPORT_COMMAND,
    },
    {
      id: "connect",
      label: "Pair this workstation",
      command: cloudWorkstationConnectCommand(origin, code),
    },
    {
      id: "run",
      label: "Linux user systemd service",
      command: cloudWorkstationServiceInstallCommand(),
    },
    {
      id: "foreground-run",
      label: "macOS/non-systemd fallback",
      command: cloudWorkstationRunCommand(),
      optional: true,
    },
  ];
}

export function cloudWorkstationRefreshIntervalMs({
  canChooseHostedWorkstation,
  hasRegisteredWorkstations,
  mutationKind,
  panelIsOpen,
}: CloudWorkstationRefreshCadenceOptions): number | null {
  if (!canChooseHostedWorkstation) {
    return null;
  }
  if (mutationKind === "attach") {
    return CLOUD_WORKSTATIONS_ATTACH_REFRESH_INTERVAL_MS;
  }
  if (panelIsOpen || !hasRegisteredWorkstations) {
    return CLOUD_WORKSTATIONS_ACTIVE_REFRESH_INTERVAL_MS;
  }
  return null;
}

function normalizeCloudWorkstation(value: unknown): NotebookRegisteredWorkstation | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = scalarString(raw.workstation_id);
  const displayName = scalarString(raw.display_name);
  if (!id || !displayName) {
    return null;
  }
  return {
    id,
    displayName,
    provider: scalarString(raw.provider),
    providerLabel: scalarString(raw.provider_label),
    status: normalizeStatus(raw.status),
    statusMessage: scalarString(raw.status_message),
    defaultEnvironmentLabel: scalarString(raw.default_environment_label),
    environmentPolicy: scalarString(raw.environment_policy),
    installedBuild: scalarString(raw.installed_build),
    channel: scalarString(raw.channel),
    workingDirectory: scalarString(raw.working_directory),
    cpuCount: scalarNumber(raw.cpu_count),
    memoryBytes: scalarNumber(raw.memory_bytes),
    updatedAt: scalarString(raw.updated_at) ?? scalarString(raw.last_seen_at),
    environments: normalizeCloudEnvironments(raw.environments),
  };
}

function normalizeCloudEnvironments(value: unknown): NotebookRegisteredWorkstation["environments"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const item = raw as Record<string, unknown>;
      const id = scalarString(item.id);
      const label = scalarString(item.label);
      if (!id || !label) return null;
      return {
        id,
        label,
        available: item.available === false ? false : true,
        detail: scalarString(item.detail),
        health: scalarString(item.health),
        isDefault: item.is_default === true || item.isDefault === true,
        policy: scalarString(item.policy),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function isNotebookRegisteredWorkstation(
  value: NotebookRegisteredWorkstation | null,
): value is NotebookRegisteredWorkstation {
  return Boolean(value);
}

function normalizeStatus(value: unknown): NotebookRegisteredWorkstation["status"] {
  return value === "online" ||
    value === "offline" ||
    value === "connecting" ||
    value === "attention" ||
    value === "unknown"
    ? value
    : "unknown";
}

function scalarString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function scalarNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object") {
    const message = scalarString((payload as Record<string, unknown>).error);
    if (message) {
      return message;
    }
  }
  return `${fallback} (${response.status})`;
}
