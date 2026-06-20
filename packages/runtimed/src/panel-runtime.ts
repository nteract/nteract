/**
 * Shared Panel/Bokeh runtime event model.
 *
 * This is deliberately not the ipykernel comm envelope. It names the Panel
 * channel, the owning notebook output, and the Bokeh patch payload that needs
 * to move between the isolated renderer and the Python runtime.
 */

export const NTERACT_PANEL_RUNTIME_MIME_TYPE =
  "application/vnd.nteract.panel-runtime.v1+json" as const;
export const PANEL_RUNTIME_PROTOCOL = "nteract.panel.runtime.v1" as const;
export const PANEL_RUNTIME_PROTOCOL_VERSION = 1 as const;

export type PanelRuntimeDirection = "iframe_to_kernel" | "kernel_to_iframe";
export type PanelRuntimeClientEventType = "channel_open" | "client_patch" | "channel_close";
export type PanelRuntimeHostEventType = "server_patch" | "ack" | "disconnected";

export interface PanelRuntimeBlobRef {
  blob: string;
  size: number;
  media_type?: string | null;
}

export type PanelRuntimeBuffer = ArrayBuffer | PanelRuntimeBlobRef;

export interface PanelRuntimeChannelPayload {
  plotId?: string | null;
  commId: string;
}

export interface PanelRuntimePatchPayload extends PanelRuntimeChannelPayload {
  data?: unknown;
  metadata?: Record<string, unknown>;
  buffers?: PanelRuntimeBuffer[];
}

export interface PanelRuntimeAckMetadata {
  msg_type: "Ready" | "Error";
  content?: string;
  traceback?: string;
  comm_id?: string;
}

export interface PanelRuntimeAckPayload extends PanelRuntimeChannelPayload {
  metadata: PanelRuntimeAckMetadata;
}

export interface PanelRuntimeDisconnectedPayload {
  plotId?: string | null;
  commId?: string | null;
  reason?: string;
}

export interface PanelRuntimeOutputContext {
  cellId?: string;
  executionCount?: number | null;
  outputId?: string | null;
  outputIds?: readonly string[];
}

export interface PanelRuntimeChannelRef {
  channelId: string;
  commId: string;
  plotId?: string | null;
  cellId?: string;
  executionCount: number | null;
  outputId: string | null;
  outputIds: readonly string[];
}

export interface PanelRuntimePatchRecord {
  data?: unknown;
  metadata: Record<string, unknown>;
  buffers: readonly PanelRuntimeBuffer[];
}

interface PanelRuntimeEventBase<TType extends string, TDirection extends PanelRuntimeDirection> {
  protocol: typeof PANEL_RUNTIME_PROTOCOL;
  version: typeof PANEL_RUNTIME_PROTOCOL_VERSION;
  type: TType;
  direction: TDirection;
}

export interface PanelRuntimeChannelOpenEvent extends PanelRuntimeEventBase<
  "channel_open",
  "iframe_to_kernel"
> {
  channel: PanelRuntimeChannelRef;
}

export interface PanelRuntimeClientPatchEvent extends PanelRuntimeEventBase<
  "client_patch",
  "iframe_to_kernel"
> {
  channel: PanelRuntimeChannelRef;
  patch: PanelRuntimePatchRecord;
}

export interface PanelRuntimeChannelCloseEvent extends PanelRuntimeEventBase<
  "channel_close",
  "iframe_to_kernel"
> {
  channel: PanelRuntimeChannelRef;
}

export interface PanelRuntimeServerPatchEvent extends PanelRuntimeEventBase<
  "server_patch",
  "kernel_to_iframe"
> {
  channel: PanelRuntimeChannelRef;
  patch: PanelRuntimePatchRecord;
}

export interface PanelRuntimeAckEvent extends PanelRuntimeEventBase<"ack", "kernel_to_iframe"> {
  channel: PanelRuntimeChannelRef;
  ack: PanelRuntimeAckMetadata;
}

export interface PanelRuntimeDisconnectedEvent extends PanelRuntimeEventBase<
  "disconnected",
  "kernel_to_iframe"
> {
  channel?: PanelRuntimeChannelRef;
  reason?: string;
}

export type PanelRuntimeClientEvent =
  | PanelRuntimeChannelOpenEvent
  | PanelRuntimeClientPatchEvent
  | PanelRuntimeChannelCloseEvent;

export type PanelRuntimeHostEvent =
  | PanelRuntimeServerPatchEvent
  | PanelRuntimeAckEvent
  | PanelRuntimeDisconnectedEvent;

export type PanelRuntimeEvent = PanelRuntimeClientEvent | PanelRuntimeHostEvent;

export interface PanelRuntimeChannelOpenMessage {
  type: "panel_channel_open";
  payload: PanelRuntimeChannelPayload;
}

export interface PanelRuntimeClientPatchMessage {
  type: "panel_client_patch";
  payload: PanelRuntimePatchPayload;
}

export interface PanelRuntimeChannelCloseMessage {
  type: "panel_channel_close";
  payload: PanelRuntimeChannelPayload;
}

export interface PanelRuntimeServerPatchMessage {
  type: "panel_server_patch";
  payload: PanelRuntimePatchPayload;
}

export interface PanelRuntimeAckMessage {
  type: "panel_ack";
  payload: PanelRuntimeAckPayload;
}

export interface PanelRuntimeDisconnectedMessage {
  type: "panel_disconnected";
  payload: PanelRuntimeDisconnectedPayload;
}

export type PanelRuntimeIframeMessage =
  | PanelRuntimeChannelOpenMessage
  | PanelRuntimeClientPatchMessage
  | PanelRuntimeChannelCloseMessage;

export type PanelRuntimeHostMessage =
  | PanelRuntimeServerPatchMessage
  | PanelRuntimeAckMessage
  | PanelRuntimeDisconnectedMessage;

const PANEL_RUNTIME_IFRAME_MESSAGE_TYPES = new Set([
  "panel_channel_open",
  "panel_client_patch",
  "panel_channel_close",
]);

const PANEL_RUNTIME_HOST_MESSAGE_TYPES = new Set([
  "panel_server_patch",
  "panel_ack",
  "panel_disconnected",
]);

function compactString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstOutputId(context: PanelRuntimeOutputContext): string | null {
  const explicit = compactString(context.outputId);
  if (explicit) return explicit;
  for (const id of context.outputIds ?? []) {
    const candidate = compactString(id);
    if (candidate) return candidate;
  }
  return null;
}

function channelKeyPart(label: string, value: string | null | undefined): string | null {
  const compact = compactString(value);
  return compact ? `${label}:${encodeURIComponent(compact)}` : null;
}

export function panelRuntimeChannelId(
  payload: PanelRuntimeChannelPayload,
  context: PanelRuntimeOutputContext = {},
): string {
  const outputId = firstOutputId(context);
  const parts = [
    channelKeyPart("cell", context.cellId),
    channelKeyPart("output", outputId),
    channelKeyPart("plot", payload.plotId),
    channelKeyPart("comm", payload.commId),
  ].filter((part): part is string => part !== null);

  return parts.join("|");
}

export function createPanelRuntimeChannelRef(
  payload: PanelRuntimeChannelPayload,
  context: PanelRuntimeOutputContext = {},
): PanelRuntimeChannelRef {
  const outputIds = [...(context.outputIds ?? [])];
  return {
    channelId: panelRuntimeChannelId(payload, context),
    commId: payload.commId,
    plotId: payload.plotId ?? null,
    cellId: compactString(context.cellId) ?? undefined,
    executionCount: context.executionCount ?? null,
    outputId: firstOutputId(context),
    outputIds,
  };
}

export function createPanelRuntimePatchRecord(
  payload: PanelRuntimePatchPayload,
): PanelRuntimePatchRecord {
  return {
    data: payload.data,
    metadata: payload.metadata ?? {},
    buffers: payload.buffers ?? [],
  };
}

export function panelRuntimeEventFromIframeMessage(
  message: PanelRuntimeIframeMessage,
  context: PanelRuntimeOutputContext = {},
): PanelRuntimeClientEvent {
  const base = {
    protocol: PANEL_RUNTIME_PROTOCOL,
    version: PANEL_RUNTIME_PROTOCOL_VERSION,
    direction: "iframe_to_kernel" as const,
  };
  const channel = createPanelRuntimeChannelRef(message.payload, context);

  switch (message.type) {
    case "panel_channel_open":
      return { ...base, type: "channel_open", channel };
    case "panel_client_patch":
      return {
        ...base,
        type: "client_patch",
        channel,
        patch: createPanelRuntimePatchRecord(message.payload),
      };
    case "panel_channel_close":
      return { ...base, type: "channel_close", channel };
  }
}

export function panelRuntimeEventFromHostMessage(
  message: PanelRuntimeHostMessage,
  context: PanelRuntimeOutputContext = {},
): PanelRuntimeHostEvent {
  const base = {
    protocol: PANEL_RUNTIME_PROTOCOL,
    version: PANEL_RUNTIME_PROTOCOL_VERSION,
    direction: "kernel_to_iframe" as const,
  };

  switch (message.type) {
    case "panel_server_patch":
      return {
        ...base,
        type: "server_patch",
        channel: createPanelRuntimeChannelRef(message.payload, context),
        patch: createPanelRuntimePatchRecord(message.payload),
      };
    case "panel_ack":
      return {
        ...base,
        type: "ack",
        channel: createPanelRuntimeChannelRef(message.payload, context),
        ack: message.payload.metadata,
      };
    case "panel_disconnected": {
      const channel = isPanelRuntimeChannelPayload(message.payload)
        ? createPanelRuntimeChannelRef(message.payload, context)
        : undefined;
      return {
        ...base,
        type: "disconnected",
        channel,
        reason: message.payload.reason,
      };
    }
  }
}

function hasObjectPayload(data: unknown): data is { type: string; payload: unknown } {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { type?: unknown }).type === "string" &&
    typeof (data as { payload?: unknown }).payload === "object" &&
    (data as { payload?: unknown }).payload !== null
  );
}

function isPanelRuntimeChannelPayload(payload: unknown): payload is PanelRuntimeChannelPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { commId?: unknown }).commId === "string" &&
    compactString((payload as { commId: string }).commId) !== null
  );
}

export function isPanelRuntimeIframeMessage(data: unknown): data is PanelRuntimeIframeMessage {
  return (
    hasObjectPayload(data) &&
    PANEL_RUNTIME_IFRAME_MESSAGE_TYPES.has(data.type) &&
    isPanelRuntimeChannelPayload(data.payload)
  );
}

export function isPanelRuntimeHostMessage(data: unknown): data is PanelRuntimeHostMessage {
  if (!hasObjectPayload(data) || !PANEL_RUNTIME_HOST_MESSAGE_TYPES.has(data.type)) {
    return false;
  }
  if (data.type === "panel_disconnected") {
    return true;
  }
  return isPanelRuntimeChannelPayload(data.payload);
}
