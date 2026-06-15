import initWasm, {
  decode_presence_frame,
  encode_cursor_presence,
  encode_heartbeat_presence,
  encode_interaction_presence,
  encode_presence_frame,
  encode_selection_presence,
  rewrite_presence_ingress,
  NotebookHandle,
  RoomHostHandle,
  MarkdownRoomHostHandle,
  MarkdownHandle,
  RuntimeStatePeerHandle,
} from "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";

let initialized: Promise<void> | undefined;

type RuntimedWasmInitInput = Parameters<typeof initWasm>[0];
type RuntimedWasmModuleOrPath = Exclude<
  Extract<RuntimedWasmInitInput, { module_or_path: unknown }>["module_or_path"],
  Promise<unknown>
>;

export function initializeRuntimedWasm(moduleOrPath?: RuntimedWasmModuleOrPath): Promise<void> {
  initialized ??= (async () => {
    const resolvedModuleOrPath = moduleOrPath ?? (await loadBundledWasmModule());
    await initWasm({ module_or_path: resolvedModuleOrPath } as RuntimedWasmInitInput);
  })().catch((error: unknown) => {
    initialized = undefined;
    throw error;
  });
  return initialized;
}

async function loadBundledWasmModule(): Promise<WebAssembly.Module> {
  const module = await import("../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm");
  return module.default;
}

export async function decodePresenceFrame(payload: Uint8Array): Promise<unknown> {
  await initializeRuntimedWasm();
  return decode_presence_frame(payload);
}

export async function encodePresenceFrame(message: unknown): Promise<Uint8Array> {
  await initializeRuntimedWasm();
  return encode_presence_frame(message);
}

export async function encodeHeartbeatPresence(peerId: string): Promise<Uint8Array> {
  await initializeRuntimedWasm();
  return encode_heartbeat_presence(peerId);
}

export function encodeHeartbeatPresenceAfterInit(peerId: string): Uint8Array {
  return encode_heartbeat_presence(peerId);
}

export function encodeCursorPresenceAfterInit(
  peerId: string,
  peerLabel: string,
  actorLabel: string,
  cellId: string,
  line: number,
  column: number,
): Uint8Array {
  return encode_cursor_presence(peerId, peerLabel, actorLabel, cellId, line, column);
}

export async function encodeCursorPresence(
  peerId: string,
  peerLabel: string,
  actorLabel: string,
  cellId: string,
  line: number,
  column: number,
): Promise<Uint8Array> {
  await initializeRuntimedWasm();
  return encode_cursor_presence(peerId, peerLabel, actorLabel, cellId, line, column);
}

export async function encodeSelectionPresence(
  peerId: string,
  peerLabel: string,
  actorLabel: string,
  cellId: string,
  anchorLine: number,
  anchorCol: number,
  headLine: number,
  headCol: number,
): Promise<Uint8Array> {
  await initializeRuntimedWasm();
  return encode_selection_presence(
    peerId,
    peerLabel,
    actorLabel,
    cellId,
    anchorLine,
    anchorCol,
    headLine,
    headCol,
  );
}

export function encodeSelectionPresenceAfterInit(
  peerId: string,
  peerLabel: string,
  actorLabel: string,
  cellId: string,
  anchorLine: number,
  anchorCol: number,
  headLine: number,
  headCol: number,
): Uint8Array {
  return encode_selection_presence(
    peerId,
    peerLabel,
    actorLabel,
    cellId,
    anchorLine,
    anchorCol,
    headLine,
    headCol,
  );
}

export async function encodeInteractionPresence(
  peerId: string,
  peerLabel: string,
  actorLabel: string,
  target: unknown,
): Promise<Uint8Array> {
  await initializeRuntimedWasm();
  return encode_interaction_presence(peerId, peerLabel, actorLabel, target);
}

export function encodeInteractionPresenceAfterInit(
  peerId: string,
  peerLabel: string,
  actorLabel: string,
  target: unknown,
): Uint8Array {
  return encode_interaction_presence(peerId, peerLabel, actorLabel, target);
}

export async function rewritePresenceIngress(
  payload: Uint8Array,
  peerId: string,
  peerLabel: string,
  principal: string,
  fallbackOperator: string,
): Promise<Uint8Array> {
  await initializeRuntimedWasm();
  return rewrite_presence_ingress(payload, peerId, peerLabel, principal, fallbackOperator);
}

export async function loadSnapshotPair(
  notebookBytes: Uint8Array,
  runtimeStateBytes: Uint8Array,
  commsBytes?: Uint8Array,
): Promise<NotebookHandle> {
  await initializeRuntimedWasm();
  const handle = NotebookHandle.load_snapshot(notebookBytes, runtimeStateBytes);
  if (commsBytes) {
    handle.load_comms_doc(commsBytes);
  }
  return handle;
}

export async function createBootstrapNotebookHandle(actorLabel: string): Promise<NotebookHandle> {
  await initializeRuntimedWasm();
  return NotebookHandle.create_bootstrap(actorLabel);
}

export async function createEmptyRoomHost(
  notebookId: string,
  actorLabel: string,
): Promise<RoomHostHandle> {
  await initializeRuntimedWasm();
  return RoomHostHandle.create_empty(notebookId, actorLabel);
}

export async function loadRoomHostSnapshot(
  notebookBytes: Uint8Array,
  runtimeStateBytes: Uint8Array,
  commsBytes?: Uint8Array,
): Promise<RoomHostHandle> {
  await initializeRuntimedWasm();
  const host = RoomHostHandle.load_snapshot(notebookBytes, runtimeStateBytes);
  if (commsBytes) {
    host.load_comms_doc(commsBytes);
  }
  return host;
}

export async function createEmptyMarkdownRoomHost(
  documentId: string,
  title: string,
  actorLabel: string,
): Promise<MarkdownRoomHostHandle> {
  await initializeRuntimedWasm();
  return MarkdownRoomHostHandle.create_empty(documentId, title, actorLabel);
}

export async function loadMarkdownRoomHostSnapshot(
  markdownBytes: Uint8Array,
): Promise<MarkdownRoomHostHandle> {
  await initializeRuntimedWasm();
  return MarkdownRoomHostHandle.load_snapshot(markdownBytes);
}

export {
  NotebookHandle,
  RoomHostHandle,
  RuntimeStatePeerHandle,
  MarkdownRoomHostHandle,
  MarkdownHandle,
};
