import initWasm, {
  decode_presence_frame,
  encode_presence_frame,
  rewrite_presence_ingress,
  NotebookHandle,
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
): Promise<NotebookHandle> {
  await initializeRuntimedWasm();
  return NotebookHandle.load_snapshot(notebookBytes, runtimeStateBytes);
}
