import type { Env } from "./cloudflare-types.ts";
import { RoomMaterializer, type RoomHostFrameResult } from "./room-materializer.ts";
import { RuntimeStatePeerHandle } from "./runtimed-wasm.ts";
import { prepare_output_content } from "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";
import { FrameType, encodeTypedFrame } from "./protocol.ts";
import { managedPythonStub, MANAGED_PYTHON_WORKSTATION } from "./managed-python.ts";
import { storeManagedPythonBlob } from "./managed-python-blobs.ts";
import {
  PythonRuntimePeer,
  type PythonExecutionResult,
} from "../../preview-python/src/runtime-peer.js";
import { createOutputPreparer } from "../../preview-python/src/output-manifests.js";
import {
  packageManifest,
  type PackageManifest,
  type PackageResult,
} from "../../preview-python/src/package-service.js";

/** Trusted room-local Automerge peer; the private compute service sees no room credentials. */
export class ManagedPythonRoom {
  private readonly handle: RuntimeStatePeerHandle;
  private readonly peer;
  private readonly bridge: PythonRuntimePeer;
  private readonly pending: Uint8Array[] = [];
  private active = true;
  private readonly packageWaitAbort = new AbortController();
  private syncing: Promise<void> = Promise.resolve();
  private pumping: Promise<void> | undefined;
  private wakeRequested = false;
  private installingPackages = false;
  private packagesBlocked = false;
  private installedPackages: string[] = [];
  private packageOperationId: string | undefined;
  private readonly connectedAt = new Date().toISOString();

  get presence() {
    return {
      peer_id: this.peer.id,
      actor_label: this.peer.identity.actorLabel,
      connection_scope: "runtime_peer",
      participant_key: this.peer.id,
      display_name: "Python (sandboxed)",
      connected_at: this.connectedAt,
    };
  }

  constructor(
    private readonly env: Env,
    private readonly materializer: RoomMaterializer,
    private readonly notebookId: string,
    readonly ownerPrincipal: string,
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
          await storeManagedPythonBlob(env, notebookId, { hash, bytes, mediaType });
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
    if (!response.ok) {
      const body = await response.text();
      let reason = body;
      try {
        const parsed = JSON.parse(body) as { error?: unknown };
        if (typeof parsed.error === "string") reason = parsed.error;
      } catch {
        /* A non-JSON provider failure still needs a bounded diagnostic. */
      }
      throw new Error(
        reason.replace(/^Error: /, "").slice(0, 1000) || "Python request failed. Try again.",
      );
    }
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
    const inventory = (await this.call("/packages/inventory")) as { installed?: string[] };
    this.installedPackages = inventory.installed ?? [];
    let manifest;
    try {
      manifest = packageManifest(await this.materializer.getCloudPackageManifest());
    } catch {
      this.packagesBlocked = true;
      const error =
        "Saved packages cannot be restored for this Python version. Remove incompatible requirements or clear saved packages, then restart Python.";
      await this.publishPackageState("error", error);
      throw new Error(error);
    }
    if (manifest.requirements.length) {
      const restored = await this.installPackages(manifest, "restore");
      if (restored.status !== "ready") {
        this.packagesBlocked = true;
        await this.publishPackageState("error", restored.error);
        throw new Error(restored.error);
      }
    } else await this.publishPackageState("ready");
    this.handle.set_kernel_running("python", "python", "celld-pyodide", this.peer.id);
    this.handle.refresh_execution_queue();
    await this.synchronize();
    await this.materializer.checkpoint();
  }

  wake(): Promise<void> {
    if (this.installingPackages || this.packagesBlocked) return Promise.resolve();
    this.wakeRequested = true;
    this.pumping ??= (async () => {
      try {
        do {
          this.wakeRequested = false;
          await this.synchronize();
          await this.bridge.drain();
          // New intent can arrive after drain's final sync but before its
          // checkpoint completes. Sync again before treating the queue as empty.
        } while (this.active && this.wakeRequested);
      } finally {
        this.pumping = undefined;
      }
    })();
    return this.pumping;
  }

  private assertPackageSession(): void {
    if (!this.active) throw new Error("Managed session expired");
    const state = this.handle.get_runtime_state() as {
      workstation?: { runtime_session_id?: string };
    };
    if (state.workstation?.runtime_session_id !== this.sessionId)
      throw new Error("Managed session replaced");
  }

  private async publishPackageState(
    phase: "ready" | "installing" | "restoring" | "error",
    error: string | null = null,
    message: string | null = null,
  ): Promise<void> {
    this.assertPackageSession();
    this.apply(
      await this.materializer.setCloudPackageState(this.sessionId, {
        phase:
          phase === "ready"
            ? "install_complete"
            : phase === "error"
              ? "error"
              : "installing_packages",
        elapsed_ms: 0,
        packages: [],
        message: message ?? error,
        managed_packages: {
          session_id: this.sessionId,
          operation_id: this.packageOperationId,
          phase,
          installed: this.installedPackages,
          error,
          needs_restart: this.packagesBlocked,
        },
      }),
    );
    await this.synchronize();
    await this.materializer.checkpoint();
  }

  private async waitForPackageCapacity(delay: number): Promise<void> {
    const signal = this.packageWaitAbort.signal;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, delay);
      signal.addEventListener("abort", abort, { once: true });
    });
    this.assertPackageSession();
  }

  async installPackages(
    manifest: PackageManifest,
    operation: "add" | "restore",
    requirement?: string,
    operationId: string = crypto.randomUUID(),
  ): Promise<PackageResult> {
    if (typeof operationId !== "string" || !operationId || operationId.length > 128)
      throw new Error("Invalid package operation ID");
    if (this.installingPackages || this.packagesBlocked)
      throw new Error("Python packages are busy or need a restart");
    this.installingPackages = true;
    this.packageOperationId = operationId;
    try {
      await this.pumping;
      await this.publishPackageState(operation === "restore" ? "restoring" : "installing");
      // Only pre-install capacity rejection is retryable. Preserve the same
      // logical progress operation, with fresh provider attempt IDs for replay
      // protection. No second artifact buffer or owner queue is allocated here.
      const retryUntil = Date.now() + 180_000;
      let delay = 1_000;
      let attemptId = operationId;
      let result: PackageResult;
      for (;;) {
        this.assertPackageSession();
        try {
          result = (await this.call("/packages", {
            manifest,
            operation,
            requirement,
            operation_id: attemptId,
          })) as PackageResult;
        } catch {
          // Only an unconfirmed provider call makes installed state uncertain.
          // Progress/checkpoint failures before or after it remain retryable.
          this.assertPackageSession();
          this.packagesBlocked = true;
          const error =
            "The package operation could not be confirmed. Restart Python to restore saved requirements.";
          this.handle.set_kernel_error(error);
          await this.publishPackageState("error", error).catch(() => undefined);
          this.assertPackageSession();
          return { status: "error", error, needs_restart: true };
        }
        this.assertPackageSession();
        if (
          operation !== "restore" ||
          result.status !== "error" ||
          result.code !== "planner_busy" ||
          result.needs_restart ||
          Date.now() >= retryUntil
        )
          break;
        await this.publishPackageState(
          "restoring",
          null,
          "Waiting for another package installation before restoring saved packages…",
        );
        await this.waitForPackageCapacity(Math.min(delay, retryUntil - Date.now()));
        await this.publishPackageState("restoring");
        // Do not issue a new attempt after the bounded admission wait expires.
        if (Date.now() >= retryUntil) break;
        delay = Math.min(delay * 2, 10_000);
        attemptId = crypto.randomUUID();
      }
      if (result.status === "ready") {
        this.installedPackages = result.installed;
        await this.publishPackageState("ready");
      } else {
        this.packagesBlocked = result.needs_restart;
        if (this.packagesBlocked)
          this.handle.set_kernel_error("Package installation needs a restart");
        await this.publishPackageState("error", result.error);
      }
      return result;
    } catch (error) {
      this.assertPackageSession();
      if (!this.packagesBlocked) {
        // Clear transient progress when publication recovers, without turning
        // a confirmed install (or work never sent) into an uncertain runtime.
        await this.publishPackageState(
          "error",
          "Package changes could not be saved. Check the connection and try again.",
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      this.installingPackages = false;
    }
  }

  async close(): Promise<void> {
    this.active = false;
    this.packageWaitAbort.abort();
    await this.bridge.close();
    await this.pumping?.catch(() => undefined);
    await this.syncing;
    await this.materializer.removePeer(this.peer.id);
    this.handle.free();
  }
}
