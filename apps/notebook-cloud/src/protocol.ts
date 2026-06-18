import {
  FrameType,
  MAX_FRAME_SIZE,
  frameSizeLimits,
  type FrameSizeLimits,
  type FrameTypeValue,
} from "runtimed";

export { FrameType, MAX_FRAME_SIZE, frameSizeLimits };
export type { FrameSizeLimits, FrameTypeValue };

export const NOTEBOOK_PROTOCOL = "v4";

/**
 * Liveness probe text messages. The client pings on an interval; the room
 * DO answers via the runtime's WebSocket auto-response (no DO wake), with
 * a manual fallback in the room's message handler for runtimes without
 * auto-response support. Text (not typed binary frames) on purpose: the
 * auto-response API matches string messages, and the typed-frame channel
 * stays binary-only.
 */
export const LIVENESS_PING = "nteract-liveness-ping";
export const LIVENESS_PONG = "nteract-liveness-pong";

export interface CloudRoomPeerRosterEntry {
  peer_id: string;
  actor_label: string;
  connection_scope: string;
  participant_key: string;
  identity_provider?: string;
  principal_namespace?: string;
  display_name?: string;
  connected_at: string;
}

export interface TypedFrame {
  type: FrameTypeValue;
  payload: Uint8Array;
}

export type SessionControlMessage =
  | {
      type: "cloud_room_ready";
      protocol: typeof NOTEBOOK_PROTOCOL;
      notebook_id: string;
      comments_doc_id?: string;
      peer_id: string;
      actor_label: string;
      connection_scope: string;
      identity_provider?: string;
      principal_namespace?: string;
      display_name?: string;
      email?: string;
      room_peer_count: number;
      runtime_peer_count?: number;
      peers?: CloudRoomPeerRosterEntry[];
      timestamp: string;
    }
  | {
      type: "cloud_frame_accepted";
      notebook_id: string;
      peer_id: string;
      frame_type: number;
      byte_length: number;
      timestamp: string;
    }
  | {
      type: "cloud_frame_rejected";
      notebook_id: string;
      peer_id: string;
      frame_type?: number;
      reason: string;
      timestamp: string;
    }
  | {
      type: "cloud_room_degraded";
      notebook_id: string;
      peer_id: string;
      reason: string;
      timestamp: string;
    }
  | {
      type: "cloud_peer_joined" | "cloud_peer_left";
      notebook_id: string;
      peer_id: string;
      actor_label: string;
      connection_scope?: string;
      participant_key?: string;
      display_name?: string;
      room_peer_count: number;
      runtime_peer_count?: number;
      timestamp: string;
    };

export function encodeTypedFrame(type: FrameTypeValue, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.byteLength + 1);
  frame[0] = type;
  frame.set(payload, 1);
  return frame;
}

export function encodeJsonFrame(type: FrameTypeValue, value: unknown): Uint8Array {
  return encodeTypedFrame(type, new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeJsonPayload<T>(payload: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(payload)) as T;
}

export function splitTypedFrame(message: ArrayBuffer | ArrayBufferView): TypedFrame {
  const bytes = toUint8Array(message);
  if (bytes.byteLength === 0) {
    throw new Error("typed frame cannot be empty");
  }

  const type = bytes[0] as FrameTypeValue;
  if (!isKnownFrameType(type)) {
    throw new Error(`unknown frame type ${type}`);
  }

  return {
    type,
    payload: bytes.slice(1),
  };
}

const KNOWN_FRAME_TYPE_ENTRIES = Object.entries(FrameType) as Array<
  readonly [keyof typeof FrameType, FrameTypeValue]
>;
const KNOWN_FRAME_TYPES = KNOWN_FRAME_TYPE_ENTRIES.map(([, value]) => value);
const KNOWN_FRAME_TYPE_SET = new Set<number>(KNOWN_FRAME_TYPES);

const FRAME_TYPE_NAMES = Object.fromEntries(
  KNOWN_FRAME_TYPE_ENTRIES.map(([name, value]) => [value, name.toLowerCase()]),
) as Readonly<Record<FrameTypeValue, string>>;

const CLIENT_WRITABLE_FRAME_TYPES = {
  [FrameType.AUTOMERGE_SYNC]: true,
  [FrameType.REQUEST]: true,
  [FrameType.RESPONSE]: true,
  [FrameType.BROADCAST]: false,
  [FrameType.PRESENCE]: true,
  [FrameType.RUNTIME_STATE_SYNC]: true,
  [FrameType.COMMS_DOC_SYNC]: true,
  [FrameType.COMMENTS_DOC_SYNC]: true,
  [FrameType.POOL_STATE_SYNC]: true,
  [FrameType.SESSION_CONTROL]: false,
  [FrameType.PUT_BLOB]: true,
} as const satisfies Readonly<Record<FrameTypeValue, boolean>>;

export function frameTypeName(type: number): string {
  if (isKnownFrameType(type)) {
    return FRAME_TYPE_NAMES[type];
  }
  return `unknown_${type}`;
}

export function isKnownFrameType(type: number): type is FrameTypeValue {
  return KNOWN_FRAME_TYPE_SET.has(type);
}

export function isClientWritableFrame(type: FrameTypeValue): boolean {
  return CLIENT_WRITABLE_FRAME_TYPES[type];
}

export function toUint8Array(message: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }

  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}
