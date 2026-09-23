import type { Env } from "./cloudflare-types.ts";
import { RoomMaterializer, type RoomHostFrameResult } from "./room-materializer.ts";
import { RuntimeStatePeerHandle } from "./runtimed-wasm.ts";
import { prepare_output_content } from "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";
import { FrameType, encodeTypedFrame } from "./protocol.ts";
import { managedPythonStub, MANAGED_PYTHON_WORKSTATION } from "./managed-python.ts";
import { blobKey } from "./storage.ts";
import {
  PythonRuntimePeer,
  type PythonExecutionResult,
} from "../../preview-python/src/runtime-peer.js";
import { createOutputPreparer } from "../../preview-python/src/output-manifests.js";

/** Trusted room-local Automerge peer; the private compute service sees no room credentials. */
export class ManagedPythonRoom {
  private readonly handle: RuntimeStatePeerHandle;
  private readonly peer;
  private readonly bridge: PythonRuntimePeer;
  private readonly pending: Uint8Array[] = [];
  private active = true;
  private syncing: Promise<void> = Promise.resolve();
  private pumping: Promise<void> | undefined;

  constructor(
    private readonly env: Env,
    private readonly materializer: RoomMaterializer,
    private readonly notebookId: string,
    private readonly ownerPrincipal: string,
    readonly sessionId: string,
    private readonly deliver: (result: RoomHostFrameResult) => void,
  ) {
    const actorLabel = `${ownerPrincipal}/managed-python:${sessionId}`;
    this.peer = {
      id: `managed-python:${sessionId}`,
      identity: { principal: ownerPrincipal, actorLabel, scope: "runtime_peer" as const },
    };
    this.handle = new RuntimeStatePeerHandle(actorLabel);
    this.bridge = new PythonRuntimePeer({
      peer: this.handle,
      sessionKey: sessionId,
      isCurrent: (state) => {
        const current = state as {
          workstation?: { runtime_session_id?: string; workstation_id?: string };
        };
        return (
          this.active &&
          current.workstation?.runtime_session_id === sessionId &&
          current.workstation?.workstation_id === MANAGED_PYTHON_WORKSTATION
        );
      },
      publish: async () => {
        await this.synchronize();
        await materializer.checkpoint();
      },
      pool: {
        execute: async (_key, execution) =>
          this.call("/execute", { execution }) as Promise<PythonExecutionResult>,
        release: async () => {
          await this.call("/close");
        },
      },
      prepareOutputs: createOutputPreparer({
        prepareContent: prepare_output_content,
        putBlob: async ({ hash, bytes, mediaType }) => {
          if (!this.active) throw new Error("Managed session expired");
          if (!env.NOTEBOOK_SNAPSHOTS) throw new Error("Notebook blob storage unavailable");
          await env.NOTEBOOK_SNAPSHOTS.put(blobKey(notebookId, hash), bytes, {
            httpMetadata: { contentType: mediaType },
          });
        },
      }),
    });
  }

  private async call(path: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const provider = managedPythonStub(this.env);
    if (!provider) throw new Error("Managed Python provider unavailable");
    const response = await provider.fetch(
      new Request(`https://preview-python.internal${path}`, {
        method: "POST",
        body: JSON.stringify({
          ownerPrincipal: this.ownerPrincipal,
          notebookId: this.notebookId,
          sessionId: this.sessionId,
          ...extra,
        }),
      }),
    );
    if (!response.ok) throw new Error(`Managed Python ${path} failed: ${await response.text()}`);
    return response.json();
  }

  accept(result: RoomHostFrameResult): void {
    if (!this.active) return;
    for (const frame of result.outbound) {
      if (frame.peer_id === this.peer.id && frame.frame_type === FrameType.RUNTIME_STATE_SYNC) {
        this.pending.push(encodeTypedFrame(frame.frame_type, new Uint8Array(frame.payload)));
      }
    }
  }

  private apply(result: RoomHostFrameResult): void {
    this.deliver(result);
  }

  private synchronize(): Promise<void> {
    const operation = this.syncing.then(async () => {
      if (!this.active) throw new Error("Managed session expired");
      this.apply(await this.materializer.syncPeer(this.peer));
      for (let round = 0; round < 64; round++) {
        let outgoing = this.handle.flush_runtime_state_sync();
        if (outgoing)
          this.apply(
            await this.materializer.receiveFrame(this.peer, {
              type: FrameType.RUNTIME_STATE_SYNC,
              payload: outgoing,
            }),
          );
        const frames = this.pending.splice(0);
        if (!frames.length && !outgoing) return;
        for (const frame of frames) {
          const result = this.handle.receive_frame(frame) as { reply?: number[] };
          if (result.reply)
            this.apply(
              await this.materializer.receiveFrame(this.peer, {
                type: FrameType.RUNTIME_STATE_SYNC,
                payload: new Uint8Array(result.reply),
              }),
            );
        }
      }
      throw new Error("Managed runtime sync did not settle");
    });
    this.syncing = operation.catch(() => undefined);
    return operation;
  }

  async start(): Promise<void> {
    await this.call("/open");
    if (!this.active) {
      await this.call("/close");
      return;
    }
    await this.synchronize();
    this.handle.set_kernel_running("python", "python", "celld-pyodide", this.peer.id);
    this.handle.refresh_execution_queue();
    await this.synchronize();
    await this.materializer.checkpoint();
  }

  wake(): Promise<void> {
    this.pumping ??= (async () => {
      await this.synchronize();
      await this.bridge.drain();
    })().finally(() => {
      this.pumping = undefined;
    });
    return this.pumping;
  }

  async close(): Promise<void> {
    this.active = false;
    await this.bridge.close();
    await this.pumping?.catch(() => undefined);
    await this.syncing;
    await this.materializer.removePeer(this.peer.id);
    this.handle.free();
  }
}
