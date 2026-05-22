import { FrameType, type FrameTypeValue } from "runtimed/src/transport.ts";

export { FrameType };
export type { FrameTypeValue };

export const NOTEBOOK_PROTOCOL = "v4";

export interface TypedFrame {
  type: FrameTypeValue;
  payload: Uint8Array;
}

export interface FrameSizeLimits {
  cap: number;
  warn: number;
}

const KIB = 1024;
const MIB = 1024 * 1024;

export const MAX_FRAME_SIZE = 100 * MIB;

export type SessionControlMessage =
  | {
      type: "cloud_room_ready";
      protocol: typeof NOTEBOOK_PROTOCOL;
      notebook_id: string;
      peer_id: string;
      actor_label: string;
      connection_scope: string;
      room_peer_count: number;
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
      room_peer_count: number;
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
    type === FrameType.POOL_STATE_SYNC ||
    type === FrameType.PUT_BLOB
  );
}

export function frameSizeLimits(type: number): FrameSizeLimits {
  switch (type) {
    case FrameType.AUTOMERGE_SYNC:
      return { cap: 64 * MIB, warn: 16 * MIB };
    case FrameType.REQUEST:
      return { cap: 16 * MIB, warn: 256 * KIB };
    case FrameType.RESPONSE:
      return { cap: 64 * MIB, warn: 16 * MIB };
    case FrameType.BROADCAST:
      return { cap: 16 * MIB, warn: 4 * MIB };
    case FrameType.PRESENCE:
      return { cap: MIB, warn: 256 * KIB };
    case FrameType.RUNTIME_STATE_SYNC:
      return { cap: 64 * MIB, warn: 16 * MIB };
    case FrameType.POOL_STATE_SYNC:
      return { cap: MIB, warn: 256 * KIB };
    case FrameType.SESSION_CONTROL:
      return { cap: MIB, warn: 256 * KIB };
    case FrameType.PUT_BLOB:
      return { cap: 32 * MIB, warn: 8 * MIB };
    default:
      return { cap: MAX_FRAME_SIZE, warn: MAX_FRAME_SIZE / 2 };
  }
}

export function toUint8Array(message: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }

  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}
