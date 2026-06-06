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

export interface TypedFrame {
  type: FrameTypeValue;
  payload: Uint8Array;
}

export type SessionControlMessage =
  | {
      type: "cloud_room_ready";
      protocol: typeof NOTEBOOK_PROTOCOL;
      notebook_id: string;
      peer_id: string;
      actor_label: string;
      connection_scope: string;
      identity_provider?: string;
      principal_namespace?: string;
      display_name?: string;
      email?: string;
      room_peer_count: number;
      runtime_peer_count?: number;
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
      type: "cloud_peer_joined" | "cloud_peer_left";
      notebook_id: string;
      peer_id: string;
      actor_label: string;
      connection_scope?: string;
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

export function frameTypeName(type: number): string {
  switch (type) {
    case FrameType.AUTOMERGE_SYNC:
      return "automerge_sync";
    case FrameType.REQUEST:
      return "request";
    case FrameType.RESPONSE:
      return "response";
    case FrameType.BROADCAST:
      return "broadcast";
    case FrameType.PRESENCE:
      return "presence";
    case FrameType.RUNTIME_STATE_SYNC:
      return "runtime_state_sync";
    case FrameType.COMMS_DOC_SYNC:
      return "comms_doc_sync";
    case FrameType.POOL_STATE_SYNC:
      return "pool_state_sync";
    case FrameType.SESSION_CONTROL:
      return "session_control";
    case FrameType.PUT_BLOB:
      return "put_blob";
    default:
      return `unknown_${type}`;
  }
}

export function isKnownFrameType(type: number): type is FrameTypeValue {
  return Object.values(FrameType).includes(type as FrameTypeValue);
}

export function isClientWritableFrame(type: FrameTypeValue): boolean {
  return (
    type === FrameType.AUTOMERGE_SYNC ||
    type === FrameType.REQUEST ||
    type === FrameType.PRESENCE ||
    type === FrameType.RUNTIME_STATE_SYNC ||
    type === FrameType.COMMS_DOC_SYNC ||
    type === FrameType.POOL_STATE_SYNC ||
    type === FrameType.PUT_BLOB
  );
}

export function toUint8Array(message: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }

  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}
