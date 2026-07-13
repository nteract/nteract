/**
 * SyncEngine unit tests using mock handles.
 *
 * Proves the engine's lifecycle, coalescing, rollback, retry, and
 * observable emission without requiring WASM or a real daemon.
 *
 * Time-dependent tests use RxJS VirtualTimeScheduler instead of vi.useFakeTimers.
 */

import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import { VirtualTimeScheduler, VirtualAction } from "rxjs";
import { SyncEngine } from "../src/sync-engine";
import { DirectTransport } from "../src/direct-transport";
import { FrameType } from "../src/transport";
import { mergeChangesets } from "../src/cell-changeset";
import { diffExecutions } from "../src/runtime-state";
import type { SessionStatus, SyncableHandle, FrameEvent } from "../src/handle";
import type { CellChangeset } from "../src/cell-changeset";
import type { RuntimeState } from "../src/runtime-state";

// ── Mock factories ──────────────────────────────────────────────────

function createMockHandle(overrides: Partial<SyncableHandle> = {}): SyncableHandle {
  return {
    receive_frame: vi.fn(() => []),
    flush_local_changes: vi.fn(() => null),
    cancel_last_flush: vi.fn(),
    flush_runtime_state_sync: vi.fn(() => null),
    cancel_last_runtime_state_flush: vi.fn(),
    generate_runtime_state_sync_reply: vi.fn(() => null),
    flush_comms_doc_sync: vi.fn(() => null),
    cancel_last_comms_doc_flush: vi.fn(),
    generate_comms_doc_sync_reply: vi.fn(() => null),
    flush_pool_state_sync: vi.fn(() => null),
    cancel_last_pool_state_flush: vi.fn(),
    generate_pool_state_sync_reply: vi.fn(() => null),
    reset_sync_state: vi.fn(),
    cell_count: vi.fn(() => 0),
    get_heads_hex: vi.fn(() => []),
    get_dependency_fingerprint: vi.fn(() => undefined),
    ...overrides,
  };
}

function createMockServerHandle() {
  return {
    flush_local_changes: vi.fn(() => null),
    receive_sync_message: vi.fn(() => true),
    reset_sync_state: vi.fn(),
  };
}

function syncAppliedEvent(
  opts: {
    changed?: boolean;
    changeset?: CellChangeset;
    reply?: number[];
    attributions?: FrameEvent["attributions"];
    executionViewChangeset?: FrameEvent["execution_view_changeset"];
  } = {},
): FrameEvent {
  return {
    type: "sync_applied",
    changed: opts.changed ?? false,
    changeset: opts.changeset,
    reply: opts.reply,
    attributions: opts.attributions,
    execution_view_changeset: opts.executionViewChangeset,
  };
}

function broadcastEvent(payload: unknown): FrameEvent {
  return { type: "broadcast", payload };
}

function presenceEvent(payload: unknown): FrameEvent {
  return { type: "presence", payload };
}

function runtimeStateSyncEvent(
  state: RuntimeState,
  executionViewChangeset?: FrameEvent["execution_view_changeset"],
  outputChangeset?: FrameEvent["output_changeset"],
): FrameEvent {
  return {
    type: "runtime_state_sync_applied",
    changed: true,
    state,
    execution_view_changeset: executionViewChangeset,
    output_changeset: outputChangeset,
  };
}

function commsDocSyncEvent(state: Record<string, Record<string, unknown>>): FrameEvent {
  return {
    type: "comms_doc_sync_applied",
    changed: true,
    state: { comms: state },
  };
}

function sessionStatusEvent(status: SessionStatus): FrameEvent {
  return { type: "session_control", status };
}

function pendingStatus(): SessionStatus {
  return {
    notebook_doc: "pending",
    runtime_state: "pending",
    initial_load: { phase: "not_needed" },
  };
}

function interactiveStatus(): SessionStatus {
  return {
    notebook_doc: "interactive",
    runtime_state: "ready",
    initial_load: { phase: "ready" },
  };
}

function makeRuntimeState(
  executions: Record<
    string,
    {
      status: string;
      execution_count: number | null;
      success: boolean | null;
      seq?: number | null;
    }
  >,
): RuntimeState {
  return {
    kernel: {
      lifecycle: { lifecycle: "Running", activity: "Idle" },
      error_reason: null,
      error_details: null,
      name: "python3",
      language: "python",
      env_source: "",
      last_seen: null,
    },
    queue: { executing: null, queued: [] },
    env: {
      in_sync: true,
      added: [],
      removed: [],
      channels_changed: false,
      deno_changed: false,
      prewarmed_packages: [],
      progress: null,
    },
    trust: {
      status: "trusted",
      needs_approval: false,
      approved_uv_dependencies: [],
      approved_conda_dependencies: [],
      approved_conda_channels: [],
      approved_pixi_dependencies: [],
      approved_pixi_pypi_dependencies: [],
      approved_pixi_channels: [],
    },
    runtime_state_doc_id: null,
    path: null,
    project_context: { state: "Pending" },
    workstation: null,
    last_saved: null,
    file_checkpoint: { exported_heads: [], save_sequence: null, source_issue: null },
    executions: executions as RuntimeState["executions"],
    comms: {},
    bokeh_sessions: {},
  };
}

// ── Helper: advance scheduler to a given time ───────────────────────

/**
 * Advance the virtual clock by `ms` milliseconds.
 *
 * Sets `maxFrames` so `flush()` stops at the target time instead of
 * spinning forever on repeating operators like `bufferTime`.
 */
function advanceBy(scheduler: VirtualTimeScheduler, ms: number): void {
  const target = scheduler.frame + ms;
  scheduler.maxFrames = target;
  scheduler.schedule(() => {}, ms);
  scheduler.flush();
}

// ── Tests ────────────────────────────────────────────────────────────

describe("SyncEngine", () => {
  let handle: SyncableHandle;
  let server: ReturnType<typeof createMockServerHandle>;
  let transport: DirectTransport;
  let scheduler: VirtualTimeScheduler;

  beforeEach(() => {
    handle = createMockHandle();
    server = createMockServerHandle();
    transport = new DirectTransport(server);
    scheduler = new VirtualTimeScheduler(VirtualAction, Infinity);
  });

  /** Helper: create engine with the VirtualTimeScheduler injected */
  function createEngine(opts?: {
    getHandle?: () => SyncableHandle | null;
    flushDeliveryTimeoutMs?: number;
  }): SyncEngine {
    return new SyncEngine({
      getHandle: opts?.getHandle ?? (() => handle),
      transport,
      presenceHeartbeat: {
        intervalMs: 15_000,
        encode: () => new Uint8Array([0]),
      },
      scheduler,
      flushDeliveryTimeoutMs: opts?.flushDeliveryTimeoutMs,
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("starts and stops cleanly", () => {
      const engine = createEngine();
      expect(engine.running).toBe(false);
      engine.start();
      expect(engine.running).toBe(true);
      engine.stop();
      expect(engine.running).toBe(false);
    });

    it("sends required presence heartbeat immediately and on the engine interval", () => {
      const engine = createEngine();
      engine.start();
      expect(transport.sentFrames.filter((f) => f.frameType === FrameType.PRESENCE)).toHaveLength(
        1,
      );

      advanceBy(scheduler, 14_999);
      expect(transport.sentFrames.filter((f) => f.frameType === FrameType.PRESENCE)).toHaveLength(
        1,
      );

      advanceBy(scheduler, 1);
      expect(transport.sentFrames.filter((f) => f.frameType === FrameType.PRESENCE)).toHaveLength(
        2,
      );
      engine.stop();
    });

    it("start is idempotent", () => {
      const engine = createEngine();
      engine.start();
      engine.start(); // should not throw or double-subscribe
      expect(engine.running).toBe(true);
      engine.stop();
    });

    it("stop is idempotent", () => {
      const engine = createEngine();
      engine.start();
      engine.stop();
      engine.stop(); // should not throw
      expect(engine.running).toBe(false);
    });
  });

  // ── Initial sync ──────────────────────────────────────────────

  describe("initial sync", () => {
    it("emits initialSyncComplete$ when notebook_doc becomes interactive", () => {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        sessionStatusEvent(interactiveStatus()),
      ]);

      const engine = createEngine();
      engine.start();

      let completed = false;
      engine.initialSyncComplete$.subscribe(() => {
        completed = true;
      });

      transport.deliver(Array.from([0x00, 1, 2, 3]));
      expect(completed).toBe(true);
      engine.stop();
    });

    it("does not emit initialSyncComplete$ before interactive status arrives", () => {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        sessionStatusEvent(pendingStatus()),
      ]);

      const engine = createEngine();
      engine.start();

      let completed = false;
      engine.initialSyncComplete$.subscribe(() => {
        completed = true;
      });

      transport.deliver(Array.from([0x00, 1, 2, 3]));
      advanceBy(scheduler, 100);

      expect(completed).toBe(false);
      engine.stop();
    });

    it("emits sessionStatus$ snapshots in order", () => {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        sessionStatusEvent(pendingStatus()),
      ]);
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        sessionStatusEvent({
          notebook_doc: "syncing",
          runtime_state: "syncing",
          initial_load: { phase: "streaming" },
        }),
      ]);

      const engine = createEngine();
      engine.start();

      const statuses: SessionStatus[] = [];
      engine.sessionStatus$.subscribe((status) => statuses.push(status));

      transport.deliver(Array.from([0x07, 1]));
      transport.deliver(Array.from([0x07, 2]));

      expect(statuses).toEqual([
        pendingStatus(),
        {
          notebook_doc: "syncing",
          runtime_state: "syncing",
          initial_load: { phase: "streaming" },
        },
      ]);
      engine.stop();
    });

    it("resetForBootstrap emits a pending status so stale ready doesn't leak across reconnect", () => {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        sessionStatusEvent(interactiveStatus()),
      ]);

      const engine = createEngine();
      engine.start();

      const statuses: SessionStatus[] = [];
      engine.sessionStatus$.subscribe((status) => statuses.push(status));

      // First session reaches ready.
      transport.deliver(Array.from([0x07, 1]));
      expect(statuses.at(-1)?.runtime_state).toBe("ready");

      // Rebootstrap (daemon:ready path). ReplaySubject(1) must now carry
      // a pending value so late subscribers don't see a stale ready.
      engine.resetForBootstrap();
      expect(statuses.at(-1)?.runtime_state).toBe("pending");

      // A fresh subscriber also gets the pending cache, not the old ready.
      let lateSeen: SessionStatus | null = null;
      engine.sessionStatus$.subscribe((status) => (lateSeen = status));
      expect(lateSeen!.runtime_state).toBe("pending");

      engine.stop();
    });

    it("emits cell changes before initialSyncComplete$ when sync frames arrive first", () => {
      const changeset: CellChangeset = {
        changed: [{ cell_id: "cell-1", fields: { source: true } }],
        added: [],
        removed: [],
        order_changed: false,
      };
      (handle.receive_frame as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce([syncAppliedEvent({ changed: true, changeset })])
        .mockReturnValueOnce([
          sessionStatusEvent({
            notebook_doc: "interactive",
            runtime_state: "syncing",
            initial_load: { phase: "streaming" },
          }),
        ]);

      const engine = createEngine();
      engine.start();

      const materialized: Array<CellChangeset | null> = [];
      let completed = false;
      engine.cellChanges$.subscribe((cs) => materialized.push(cs));
      engine.initialSyncComplete$.subscribe(() => {
        completed = true;
      });

      transport.deliver(Array.from([0x00, 1]));
      advanceBy(scheduler, 40);

      expect(materialized).toEqual([changeset]);
      expect(completed).toBe(false);

      transport.deliver(Array.from([0x07, 1]));
      expect(completed).toBe(true);
      engine.stop();
    });
  });

  // ── Broadcasts ────────────────────────────────────────────────

  describe("broadcasts", () => {
    it("emits broadcast payloads on broadcasts$", () => {
      const broadcastPayload = { event: "kernel_status", status: "busy" };
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        broadcastEvent(broadcastPayload),
      ]);

      const engine = createEngine();
      engine.start();

      const received: unknown[] = [];
      engine.broadcasts$.subscribe((p) => received.push(p));

      transport.deliver(Array.from([0x03, 1]));
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(broadcastPayload);
      engine.stop();
    });

    it("emits text_attribution as broadcast", () => {
      const attributions = [{ cell_id: "c1", index: 0, text: "hi", deleted: 0, actors: ["a"] }];
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        syncAppliedEvent({ changed: true, attributions }),
      ]);

      const engine = createEngine();
      engine.start();

      const received: unknown[] = [];
      engine.broadcasts$.subscribe((p) => received.push(p));

      transport.deliver(Array.from([0x00, 1]));
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        type: "text_attribution",
        attributions,
      });
      engine.stop();
    });
  });

  // ── Presence ──────────────────────────────────────────────────

  describe("presence", () => {
    it("emits presence payloads on presence$", () => {
      const presencePayload = { type: "update", peer: "alice", cursor: {} };
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        presenceEvent(presencePayload),
      ]);

      const engine = createEngine();
      engine.start();

      const received: unknown[] = [];
      engine.presence$.subscribe((p) => received.push(p));

      transport.deliver(Array.from([0x04, 1]));
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(presencePayload);
      engine.stop();
    });
  });

  // ── Notebook sync applied (per inbound exchange) ──────────────

  describe("notebookSyncApplied$", () => {
    it("fires per applied inbound notebook sync frame, even when nothing changed", () => {
      // The no-op exchange is the load-bearing case: converging with a
      // peer at identical heads emits no cellChanges$/notebookDocChanged$,
      // yet hosts must learn the exchange settled.
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        syncAppliedEvent({ changed: false }),
      ]);

      const engine = createEngine();
      engine.start();

      let emissions = 0;
      engine.notebookSyncApplied$.subscribe(() => {
        emissions += 1;
      });

      transport.deliver(Array.from([0x00, 1]));
      expect(emissions).toBe(1);
      engine.stop();
    });

    it("stays silent for runtime-state sync frames", () => {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        runtimeStateSyncEvent(makeRuntimeState({})),
      ]);

      const engine = createEngine();
      engine.start();

      let emissions = 0;
      engine.notebookSyncApplied$.subscribe(() => {
        emissions += 1;
      });

      transport.deliver(Array.from([0x05, 1]));
      expect(emissions).toBe(0);
      engine.stop();
    });
  });

  // ── Cell changes (coalescing) ─────────────────────────────────

  describe("cellChanges$", () => {
    it("emits coalesced changesets after initial sync", () => {
      let callCount = 0;
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return [sessionStatusEvent(interactiveStatus())];
        }
        // Subsequent calls: steady-state changes
        return [
          syncAppliedEvent({
            changed: true,
            changeset: {
              changed: [{ cell_id: "c1", fields: { source: true } }],
              added: [],
              removed: [],
              order_changed: false,
            },
          }),
        ];
      });

      const engine = createEngine();
      engine.start();

      // Enter interactive state explicitly before steady-state sync frames.
      transport.deliver(Array.from([0x07, 1]));

      // Subscribe to cell changes
      const emissions: (CellChangeset | null)[] = [];
      engine.cellChanges$.subscribe((cs) => emissions.push(cs));

      // Send steady-state frame
      transport.deliver(Array.from([0x00, 2]));

      // Advance past coalescing window (32ms)
      advanceBy(scheduler, 50);

      expect(emissions).toHaveLength(1);
      const changeset = emissions[0];
      expect(changeset).not.toBeNull();
      expect(changeset!.changed[0].cell_id).toBe("c1");
      expect(changeset!.changed[0].fields.source).toBe(true);
      engine.stop();
    });

    it("emits null changeset when WASM has no changeset", () => {
      let callCount = 0;
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return [sessionStatusEvent(interactiveStatus())];
        }
        return [syncAppliedEvent({ changed: true })]; // no changeset
      });

      const engine = createEngine();
      engine.start();

      transport.deliver(Array.from([0x07, 1]));

      const emissions: (CellChangeset | null)[] = [];
      engine.cellChanges$.subscribe((cs) => emissions.push(cs));

      transport.deliver(Array.from([0x00, 2]));
      advanceBy(scheduler, 50);

      expect(emissions).toHaveLength(1);
      expect(emissions[0]).toBeNull();
      engine.stop();
    });

    it("merges multiple frames within the 32ms coalescing window", () => {
      let callCount = 0;
      const changesets: CellChangeset[] = [
        {
          changed: [{ cell_id: "c1", fields: { source: true } }],
          added: [],
          removed: [],
          order_changed: false,
        },
        {
          changed: [{ cell_id: "c2", fields: { outputs: true } }],
          added: [],
          removed: [],
          order_changed: false,
        },
        {
          changed: [{ cell_id: "c1", fields: { metadata: true } }],
          added: [],
          removed: [],
          order_changed: false,
        },
      ];

      (handle.receive_frame as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return [sessionStatusEvent(interactiveStatus())];
        }
        // Return different changesets for each subsequent frame
        return [syncAppliedEvent({ changed: true, changeset: changesets[callCount - 2] })];
      });

      const engine = createEngine();
      engine.start();

      transport.deliver(Array.from([0x07, 1]));

      const emissions: (CellChangeset | null)[] = [];
      engine.cellChanges$.subscribe((cs) => emissions.push(cs));

      // Send 3 frames within the 32ms window
      transport.deliver(Array.from([0x00, 2]));
      advanceBy(scheduler, 10);
      transport.deliver(Array.from([0x00, 3]));
      advanceBy(scheduler, 10);
      transport.deliver(Array.from([0x00, 4]));

      // Advance past coalescing window
      advanceBy(scheduler, 50);

      // Should get a single merged emission
      expect(emissions).toHaveLength(1);
      const cs = emissions[0]!;
      expect(cs).not.toBeNull();

      // c1 should have source + metadata merged, c2 should have outputs
      const c1 = cs.changed.find((c) => c.cell_id === "c1");
      const c2 = cs.changed.find((c) => c.cell_id === "c2");
      expect(c1).toBeDefined();
      expect(c1!.fields.source).toBe(true);
      expect(c1!.fields.metadata).toBe(true);
      expect(c2).toBeDefined();
      expect(c2!.fields.outputs).toBe(true);
      engine.stop();
    });

    it("emits initial file-load changesets immediately while load is streaming", () => {
      const streamingInteractiveStatus: SessionStatus = {
        notebook_doc: "interactive",
        runtime_state: "syncing",
        initial_load: { phase: "streaming" },
      };
      const changesets: CellChangeset[] = [
        {
          changed: [],
          added: ["c1", "c2", "c3"],
          removed: [],
          order_changed: true,
        },
        {
          changed: [],
          added: ["c4", "c5", "c6"],
          removed: [],
          order_changed: true,
        },
      ];
      let callCount = 0;
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return [sessionStatusEvent(streamingInteractiveStatus)];
        }
        return [syncAppliedEvent({ changed: true, changeset: changesets[callCount - 2] })];
      });

      const engine = createEngine();
      engine.start();

      const emissions: (CellChangeset | null)[] = [];
      engine.cellChanges$.subscribe((cs) => emissions.push(cs));

      transport.deliver(Array.from([0x07, 1]));
      transport.deliver(Array.from([0x00, 2]));
      transport.deliver(Array.from([0x00, 3]));

      expect(emissions).toEqual(changesets);
      engine.stop();
    });

    it("emits separately for frames in different coalescing windows", () => {
      let callCount = 0;
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return [sessionStatusEvent(interactiveStatus())];
        }
        return [
          syncAppliedEvent({
            changed: true,
            changeset: {
              changed: [{ cell_id: `c${callCount}`, fields: { source: true } }],
              added: [],
              removed: [],
              order_changed: false,
            },
          }),
        ];
      });

      const engine = createEngine();
      engine.start();
      transport.deliver(Array.from([0x07, 1])); // interactive status

      const emissions: (CellChangeset | null)[] = [];
      engine.cellChanges$.subscribe((cs) => emissions.push(cs));

      // First frame + flush its coalescing window
      transport.deliver(Array.from([0x00, 2]));
      advanceBy(scheduler, 50);
      expect(emissions).toHaveLength(1);

      // Second frame in a new coalescing window
      transport.deliver(Array.from([0x00, 3]));
      advanceBy(scheduler, 50);
      expect(emissions).toHaveLength(2);

      engine.stop();
    });

    it("mixed null and valid changeset in same window forces full materialization", () => {
      let callCount = 0;
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return [sessionStatusEvent(interactiveStatus())];
        }
        if (callCount === 2) {
          // Valid changeset
          return [
            syncAppliedEvent({
              changed: true,
              changeset: {
                changed: [{ cell_id: "c1", fields: { source: true } }],
                added: [],
                removed: [],
                order_changed: false,
              },
            }),
          ];
        }
        // No changeset (null) — forces full materialization
        return [syncAppliedEvent({ changed: true })];
      });

      const engine = createEngine();
      engine.start();
      transport.deliver(Array.from([0x07, 1])); // interactive status

      const emissions: (CellChangeset | null)[] = [];
      engine.cellChanges$.subscribe((cs) => emissions.push(cs));

      // Send valid changeset and null changeset within same window
      transport.deliver(Array.from([0x00, 2]));
      transport.deliver(Array.from([0x00, 3]));
      advanceBy(scheduler, 50);

      // Should emit null (full materialization needed)
      expect(emissions).toHaveLength(1);
      expect(emissions[0]).toBeNull();
      engine.stop();
    });
  });

  // ── Runtime state ─────────────────────────────────────────────

  describe("runtimeState$", () => {
    it("emits runtime state on state sync", () => {
      const state: RuntimeState = {
        kernel: {
          lifecycle: { lifecycle: "Running", activity: "Busy" },
          error_reason: null,
          error_details: null,
          name: "python3",
          language: "python",
          env_source: "",
          last_seen: null,
        },
        queue: { executing: null, queued: [] },
        env: {
          in_sync: true,
          added: [],
          removed: [],
          channels_changed: false,
          deno_changed: false,
          prewarmed_packages: [],
          progress: null,
        },
        trust: {
          status: "trusted",
          needs_approval: false,
          approved_uv_dependencies: [],
          approved_conda_dependencies: [],
          approved_conda_channels: [],
          approved_pixi_dependencies: [],
          approved_pixi_pypi_dependencies: [],
          approved_pixi_channels: [],
        },
        runtime_state_doc_id: null,
        path: null,
        project_context: { state: "Pending" },
        workstation: null,
        last_saved: null,
        file_checkpoint: { exported_heads: [], save_sequence: null, source_issue: null },
        executions: {},
        comms: {},
        bokeh_sessions: {},
      };

      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        runtimeStateSyncEvent(state),
      ]);

      const engine = createEngine();
      engine.start();

      const received: RuntimeState[] = [];
      engine.runtimeState$.subscribe((s) => received.push(s));

      transport.deliver(Array.from([0x05, 1]));

      expect(received).toHaveLength(1);
      expect(received[0].kernel.lifecycle).toEqual({ lifecycle: "Running", activity: "Busy" });
      expect(received[0].kernel.name).toBe("python3");
      engine.stop();
    });

    it("preserves project preparation env progress from state sync", () => {
      const state = makeRuntimeState({});
      state.env.progress = {
        env_type: "uv",
        phase: "project_preparing",
        source: "uv:pyproject",
        project_path: "/tmp/project/pyproject.toml",
      };

      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        runtimeStateSyncEvent(state),
      ]);

      const engine = createEngine();
      engine.start();

      const received: RuntimeState[] = [];
      engine.runtimeState$.subscribe((s) => received.push(s));

      transport.deliver(Array.from([0x05, 1]));

      expect(received).toHaveLength(1);
      expect(received[0].env.progress).toEqual({
        env_type: "uv",
        phase: "project_preparing",
        source: "uv:pyproject",
        project_path: "/tmp/project/pyproject.toml",
      });
      engine.stop();
    });
  });

  // ── Execution transitions ─────────────────────────────────────

  describe("executionTransitions$", () => {
    it("detects started transition", () => {
      const state: RuntimeState = {
        kernel: {
          lifecycle: { lifecycle: "Running", activity: "Busy" },
          error_reason: null,
          error_details: null,
          name: "python3",
          language: "python",
          env_source: "",
          last_seen: null,
        },
        queue: { executing: null, queued: [] },
        env: {
          in_sync: true,
          added: [],
          removed: [],
          channels_changed: false,
          deno_changed: false,
          prewarmed_packages: [],
          progress: null,
        },
        trust: {
          status: "trusted",
          needs_approval: false,
          approved_uv_dependencies: [],
          approved_conda_dependencies: [],
          approved_conda_channels: [],
          approved_pixi_dependencies: [],
          approved_pixi_pypi_dependencies: [],
          approved_pixi_channels: [],
        },
        runtime_state_doc_id: null,
        path: null,
        project_context: { state: "Pending" },
        workstation: null,
        last_saved: null,
        file_checkpoint: { exported_heads: [], save_sequence: null, source_issue: null },
        executions: {
          "exec-1": {
            status: "running",
            execution_count: 1,
            success: null,
          },
        },
        comms: {},
        bokeh_sessions: {},
      };

      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        runtimeStateSyncEvent(state),
      ]);

      const engine = createEngine();
      engine.start();

      const received: import("../src/runtime-state").ExecutionTransition[][] = [];
      engine.executionTransitions$.subscribe((t) => received.push(t));

      transport.deliver(Array.from([0x05, 1]));

      expect(received).toHaveLength(1);
      expect(received[0]).toHaveLength(1);
      expect(received[0][0].kind).toBe("started");
      expect(received[0][0].execution_id).toBe("exec-1");
      engine.stop();
    });
  });

  describe("executionViewChanges$", () => {
    it("emits notebook pointer changes from sync_applied events", () => {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        syncAppliedEvent({
          changed: true,
          executionViewChangeset: {
            cell_pointer_changes: [["cell-1", "exec-1"]],
          },
        }),
      ]);

      const engine = createEngine();
      engine.start();

      const received: NonNullable<FrameEvent["execution_view_changeset"]>[] = [];
      engine.executionViewChanges$.subscribe((changeset) => received.push(changeset));

      transport.deliver(Array.from([0x00, 1]));

      expect(received).toEqual([
        {
          cell_pointer_changes: [["cell-1", "exec-1"]],
        },
      ]);
      engine.stop();
    });

    it("emits runtime execution upserts and removals from runtime-state events", () => {
      const state = makeRuntimeState({
        "exec-1": { status: "running", execution_count: 1, success: null },
      });
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        runtimeStateSyncEvent(state, {
          execution_upserts: [
            [
              "exec-1",
              {
                execution_count: 1,
                status: "running",
                success: null,
                output_ids: ["out-1"],
              },
            ],
          ],
          removed_execution_ids: ["exec-old"],
          queue: {
            executing_execution_id: "exec-1",
            queued_execution_ids: [],
          },
        }),
      ]);

      const engine = createEngine();
      engine.start();

      const received: NonNullable<FrameEvent["execution_view_changeset"]>[] = [];
      engine.executionViewChanges$.subscribe((changeset) => received.push(changeset));

      transport.deliver(Array.from([0x05, 1]));

      expect(received).toEqual([
        {
          execution_upserts: [
            [
              "exec-1",
              {
                execution_count: 1,
                status: "running",
                success: null,
                output_ids: ["out-1"],
              },
            ],
          ],
          removed_execution_ids: ["exec-old"],
          queue: {
            executing_execution_id: "exec-1",
            queued_execution_ids: [],
          },
        },
      ]);
      engine.stop();
    });

    it("executionQueue$ dedups queue membership across changeset ticks", () => {
      const state = makeRuntimeState({
        "exec-1": { status: "running", execution_count: 1, success: null },
      });
      const queue = {
        executing_execution_id: "exec-1",
        queued_execution_ids: ["exec-2"],
        notebook: { executing_cell_id: "cell-1", queued_cell_ids: ["cell-2"] },
      };
      const engine = createEngine();
      engine.start();

      const received: unknown[] = [];
      engine.executionQueue$.subscribe((projection) => received.push(projection));

      // Tick 1: queue appears.
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        runtimeStateSyncEvent(state, { queue }),
      ]);
      transport.deliver(Array.from([0x05, 1]));

      // Tick 2: output churn during the same execution — same queue content
      // in a fresh object. Queue-only subscribers must not be re-notified.
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        runtimeStateSyncEvent(state, {
          execution_upserts: [
            [
              "exec-1",
              { execution_count: 1, status: "running", success: null, output_ids: ["out-1"] },
            ],
          ],
          queue: { ...queue, notebook: { ...queue.notebook } },
        }),
      ]);
      transport.deliver(Array.from([0x05, 2]));

      // Tick 3: queue drains.
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        runtimeStateSyncEvent(state, {
          queue: { executing_execution_id: null, queued_execution_ids: [], notebook: null },
        }),
      ]);
      transport.deliver(Array.from([0x05, 3]));

      expect(received).toEqual([
        queue,
        { executing_execution_id: null, queued_execution_ids: [], notebook: null },
      ]);
      engine.stop();
    });

    it("emits output payload changes before runtime execution view changes", () => {
      const state = makeRuntimeState({
        "exec-1": { status: "running", execution_count: 1, success: null },
      });
      const executionChanges: NonNullable<FrameEvent["execution_view_changeset"]> = {
        execution_upserts: [
          [
            "exec-1",
            {
              execution_count: 1,
              status: "running",
              success: null,
              output_ids: ["out-1"],
            },
          ],
        ],
        cell_pointer_changes: [["cell-1", "exec-1"]],
      };
      const outputChanges: NonNullable<FrameEvent["output_changeset"]> = {
        changed: [["out-1", { output_type: "stream", name: "stdout", text: "ready" }]],
        removed: [],
      };
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        runtimeStateSyncEvent(state, executionChanges, outputChanges),
      ]);

      const engine = createEngine();
      engine.start();

      const order: string[] = [];
      const receivedOutputs: Array<{ changed: Array<[string, unknown]>; removed_ids: string[] }> =
        [];
      const receivedExecutions: NonNullable<FrameEvent["execution_view_changeset"]>[] = [];
      engine.outputIdChanges$.subscribe((changeset) => {
        order.push("outputs");
        receivedOutputs.push(changeset);
      });
      engine.executionViewChanges$.subscribe((changeset) => {
        order.push("execution");
        receivedExecutions.push(changeset);
      });

      transport.deliver(Array.from([0x05, 1]));

      expect(order).toEqual(["outputs", "execution"]);
      expect(receivedOutputs).toEqual([
        {
          changed: outputChanges.changed,
          removed_ids: [],
        },
      ]);
      expect(receivedExecutions).toEqual([executionChanges]);
      engine.stop();
    });

    it("emits recovered runtime-state execution view changes from sync errors", () => {
      const state = makeRuntimeState({
        "exec-1": { status: "running", execution_count: 1, success: null },
      });
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          type: "runtime_state_sync_error",
          changed: true,
          state,
          execution_view_changeset: {
            queue: {
              executing_execution_id: "exec-1",
              queued_execution_ids: ["exec-2"],
              notebook: {
                executing_cell_id: "cell-1",
                queued_cell_ids: ["cell-2"],
              },
            },
          },
        },
      ]);

      const engine = createEngine();
      engine.start();

      const received: NonNullable<FrameEvent["execution_view_changeset"]>[] = [];
      engine.executionViewChanges$.subscribe((changeset) => received.push(changeset));

      transport.deliver(Array.from([0x05, 1]));

      expect(received).toEqual([
        {
          queue: {
            executing_execution_id: "exec-1",
            queued_execution_ids: ["exec-2"],
            notebook: {
              executing_cell_id: "cell-1",
              queued_cell_ids: ["cell-2"],
            },
          },
        },
      ]);
      engine.stop();
    });

    it("does not emit empty execution-view changesets", () => {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        syncAppliedEvent({
          changed: true,
          executionViewChangeset: {},
        }),
      ]);

      const engine = createEngine();
      engine.start();

      const received: NonNullable<FrameEvent["execution_view_changeset"]>[] = [];
      engine.executionViewChanges$.subscribe((changeset) => received.push(changeset));

      transport.deliver(Array.from([0x00, 1]));

      expect(received).toEqual([]);
      engine.stop();
    });
  });

  // ── Inline sync reply ─────────────────────────────────────────

  describe("sync replies", () => {
    it("sends inline sync reply via transport", () => {
      const reply = [10, 20, 30];
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        syncAppliedEvent({ changed: true, reply }),
      ]);

      const engine = createEngine();
      engine.start();
      transport.deliver(Array.from([0x00, 1]));

      // Check that a sync frame was sent
      const syncFrames = transport.sentFrames.filter(
        (f) => f.frameType === FrameType.AUTOMERGE_SYNC,
      );
      expect(syncFrames.length).toBeGreaterThanOrEqual(1);
      engine.stop();
    });

    it("rolls back sync state on send failure", async () => {
      const reply = [10, 20, 30];
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        syncAppliedEvent({ changed: true, reply }),
      ]);

      transport.simulateFailure = true;
      const engine = createEngine();
      engine.start();
      transport.deliver(Array.from([0x00, 1]));

      // Let the promise rejection propagate
      await Promise.resolve();

      expect(handle.cancel_last_flush).toHaveBeenCalled();
      engine.stop();
    });
  });

  // ── Outbound flush ────────────────────────────────────────────

  describe("flush", () => {
    it("flush() sends local changes via transport", () => {
      const syncMsg = new Uint8Array([1, 2, 3]);
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(syncMsg);

      const engine = createEngine();
      engine.start();
      engine.flush();

      const syncFrames = transport.sentFrames.filter(
        (f) => f.frameType === FrameType.AUTOMERGE_SYNC,
      );
      expect(syncFrames).toHaveLength(1);
      expect(syncFrames[0].payload).toEqual(syncMsg);
      engine.stop();
    });

    it("flush() also sends RuntimeStateDoc sync", () => {
      const stateMsg = new Uint8Array([4, 5, 6]);
      (handle.flush_runtime_state_sync as ReturnType<typeof vi.fn>).mockReturnValue(stateMsg);

      const engine = createEngine();
      engine.start();
      engine.flush();

      const stateFrames = transport.sentFrames.filter(
        (f) => f.frameType === FrameType.RUNTIME_STATE_SYNC,
      );
      expect(stateFrames).toHaveLength(1);
      expect(stateFrames[0].payload).toEqual(stateMsg);
      engine.stop();
    });

    it("flush() also sends CommsDoc sync", () => {
      const commsMsg = new Uint8Array([8, 9, 10]);
      (handle.flush_comms_doc_sync as ReturnType<typeof vi.fn>).mockReturnValue(commsMsg);

      const engine = createEngine();
      engine.start();
      engine.flush();

      const commsFrames = transport.sentFrames.filter(
        (f) => f.frameType === FrameType.COMMS_DOC_SYNC,
      );
      expect(commsFrames).toHaveLength(1);
      expect(commsFrames[0].payload).toEqual(commsMsg);
      engine.stop();
    });

    it("flush() rolls back on transport failure", async () => {
      const syncMsg = new Uint8Array([1, 2, 3]);
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(syncMsg);

      transport.simulateFailure = true;
      const engine = createEngine();
      engine.start();
      engine.flush();

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(handle.cancel_last_flush).toHaveBeenCalled();
      engine.stop();
    });

    it.each([
      {
        name: "runtime state",
        frameType: FrameType.RUNTIME_STATE_SYNC,
        flush: () =>
          (handle.flush_runtime_state_sync as ReturnType<typeof vi.fn>).mockReturnValue(
            new Uint8Array([4, 5, 6]),
          ),
        cancel: () => handle.cancel_last_runtime_state_flush,
      },
      {
        name: "comms doc",
        frameType: FrameType.COMMS_DOC_SYNC,
        flush: () =>
          (handle.flush_comms_doc_sync as ReturnType<typeof vi.fn>).mockReturnValue(
            new Uint8Array([8, 9, 10]),
          ),
        cancel: () => handle.cancel_last_comms_doc_flush,
      },
      {
        name: "pool state",
        frameType: FrameType.POOL_STATE_SYNC,
        flush: () =>
          (handle.flush_pool_state_sync as ReturnType<typeof vi.fn>).mockReturnValue(
            new Uint8Array([7, 8, 9]),
          ),
        cancel: () => handle.cancel_last_pool_state_flush,
      },
    ])("flush() times out stuck $name frame delivery", async ({ frameType, flush, cancel }) => {
      flush();
      vi.spyOn(transport, "sendFrame").mockImplementation((actualFrameType) => {
        if (actualFrameType === frameType) return new Promise(() => {});
        return Promise.resolve();
      });

      const engine = createEngine({ flushDeliveryTimeoutMs: 5 });
      engine.start();
      engine.flush();

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cancel()).toHaveBeenCalled();
      engine.stop();
    });

    it.each([
      {
        name: "notebook doc",
        frameType: FrameType.AUTOMERGE_SYNC,
        flush: () =>
          (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(
            new Uint8Array([1, 2, 3]),
          ),
        cancel: () => handle.cancel_last_flush,
      },
      {
        name: "runtime state",
        frameType: FrameType.RUNTIME_STATE_SYNC,
        flush: () =>
          (handle.flush_runtime_state_sync as ReturnType<typeof vi.fn>).mockReturnValue(
            new Uint8Array([4, 5, 6]),
          ),
        cancel: () => handle.cancel_last_runtime_state_flush,
      },
      {
        name: "comms doc",
        frameType: FrameType.COMMS_DOC_SYNC,
        flush: () =>
          (handle.flush_comms_doc_sync as ReturnType<typeof vi.fn>).mockReturnValue(
            new Uint8Array([8, 9, 10]),
          ),
        cancel: () => handle.cancel_last_comms_doc_flush,
      },
      {
        name: "pool state",
        frameType: FrameType.POOL_STATE_SYNC,
        flush: () =>
          (handle.flush_pool_state_sync as ReturnType<typeof vi.fn>).mockReturnValue(
            new Uint8Array([7, 8, 9]),
          ),
        cancel: () => handle.cancel_last_pool_state_flush,
      },
    ])(
      "flushAndWait() times out stuck $name frame delivery",
      async ({ frameType, flush, cancel }) => {
        flush();
        vi.spyOn(transport, "sendFrame").mockImplementation((actualFrameType) => {
          if (actualFrameType === frameType) return new Promise(() => {});
          return Promise.resolve();
        });

        const engine = createEngine({ flushDeliveryTimeoutMs: 5 });
        engine.start();

        const result = await Promise.race([
          engine.flushAndWait(),
          new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
        ]);

        expect(result).toBe(false);
        expect(cancel()).toHaveBeenCalled();
        engine.stop();
      },
    );

    it("flushAndWait() consumes delivery rejections that arrive after timeout", async () => {
      const syncMsg = new Uint8Array([1, 2, 3]);
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(syncMsg);
      let rejectDelivery: (reason?: unknown) => void = () => {};
      vi.spyOn(transport, "sendFrame").mockReturnValue(
        new Promise((_, reject) => {
          rejectDelivery = reject;
        }),
      );

      const engine = createEngine({ flushDeliveryTimeoutMs: 5 });
      engine.start();
      const result = await engine.flushAndWait();

      expect(result).toBe(false);
      expect(handle.cancel_last_flush).toHaveBeenCalledTimes(1);

      rejectDelivery(new Error("late send failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handle.cancel_last_flush).toHaveBeenCalledTimes(1);
      engine.stop();
    });

    it("scheduleFlush() debounces at 20ms", () => {
      const syncMsg = new Uint8Array([1]);
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(syncMsg);

      const engine = createEngine();
      engine.start();
      transport.sentFrames.length = 0;
      engine.scheduleFlush();
      engine.scheduleFlush();
      engine.scheduleFlush();

      // No flush yet
      expect(transport.sentFrames).toHaveLength(0);

      // Advance past debounce (20ms)
      advanceBy(scheduler, 25);

      // Should have flushed exactly once
      const syncFrames = transport.sentFrames.filter(
        (f) => f.frameType === FrameType.AUTOMERGE_SYNC,
      );
      expect(syncFrames).toHaveLength(1);
      engine.stop();
    });

    it("scheduleFlush() resets debounce timer on each call", () => {
      const syncMsg = new Uint8Array([1]);
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(syncMsg);

      const engine = createEngine();
      engine.start();
      transport.sentFrames.length = 0;

      // First call at t=0
      engine.scheduleFlush();

      // Advance 15ms (not yet past 20ms debounce)
      advanceBy(scheduler, 15);
      expect(transport.sentFrames).toHaveLength(0);

      // Second call resets the timer at t=15
      engine.scheduleFlush();

      // Advance 15ms more (t=30, but only 15ms since last call)
      advanceBy(scheduler, 15);
      expect(transport.sentFrames).toHaveLength(0);

      // Advance 10ms more (t=40, 25ms since last call — past 20ms debounce)
      advanceBy(scheduler, 10);

      const syncFrames = transport.sentFrames.filter(
        (f) => f.frameType === FrameType.AUTOMERGE_SYNC,
      );
      expect(syncFrames).toHaveLength(1);
      engine.stop();
    });
  });

  // ── notebookDocChanged$ ───────────────────────────────────────

  describe("notebookDocChanged$", () => {
    it("fires on inbound sync_applied with changed=true", () => {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        syncAppliedEvent({ changed: true }),
      ]);

      const engine = createEngine();
      engine.start();

      let emissions = 0;
      engine.notebookDocChanged$.subscribe(() => {
        emissions++;
      });

      transport.deliver(Array.from([0x00, 1]));
      expect(emissions).toBe(1);
      engine.stop();
    });

    it("does not fire on sync_applied with changed=false", () => {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        syncAppliedEvent({ changed: false, reply: [10, 20] }),
      ]);

      const engine = createEngine();
      engine.start();

      let emissions = 0;
      engine.notebookDocChanged$.subscribe(() => {
        emissions++;
      });

      transport.deliver(Array.from([0x00, 1]));
      expect(emissions).toBe(0);
      engine.stop();
    });

    it("fires on a local flush that produces bytes", () => {
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(
        new Uint8Array([1, 2, 3]),
      );

      const engine = createEngine();
      engine.start();

      let emissions = 0;
      engine.notebookDocChanged$.subscribe(() => {
        emissions++;
      });

      engine.flush();
      expect(emissions).toBe(1);
      engine.stop();
    });

    it("fires delivery after a local flush is accepted", async () => {
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(
        new Uint8Array([1, 2, 3]),
      );

      const engine = createEngine();
      engine.start();

      let deliveries = 0;
      engine.notebookDocFlushDelivered$.subscribe(() => {
        deliveries++;
      });

      engine.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deliveries).toBe(1);
      engine.stop();
    });

    it("replays the latest accepted local flush to late subscribers", async () => {
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(
        new Uint8Array([1, 2, 3]),
      );

      const engine = createEngine();
      engine.start();

      engine.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let deliveries = 0;
      engine.notebookDocFlushDelivered$.subscribe(() => {
        deliveries++;
      });
      expect(deliveries).toBe(1);
      engine.stop();
    });

    it("does not fire delivery when a local flush fails", async () => {
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(
        new Uint8Array([1, 2, 3]),
      );
      transport.simulateFailure = true;

      const engine = createEngine();
      engine.start();

      let deliveries = 0;
      engine.notebookDocFlushDelivered$.subscribe(() => {
        deliveries++;
      });

      engine.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deliveries).toBe(0);
      engine.stop();
    });

    it("does not fire on a no-op flush", () => {
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const engine = createEngine();
      engine.start();

      let emissions = 0;
      engine.notebookDocChanged$.subscribe(() => {
        emissions++;
      });

      engine.flush();
      expect(emissions).toBe(0);
      engine.stop();
    });

    it("fires on the flush attempt even when delivery fails", async () => {
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(
        new Uint8Array([1, 2, 3]),
      );
      transport.simulateFailure = true;

      const engine = createEngine();
      engine.start();

      let emissions = 0;
      engine.notebookDocChanged$.subscribe(() => {
        emissions++;
      });

      engine.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The doc changed locally either way — cancel_last_flush rolled back
      // sync bookkeeping, not the document.
      expect(emissions).toBe(1);
      expect(handle.cancel_last_flush).toHaveBeenCalled();
      engine.stop();
    });

    it("fires on flushAndWait when it produces bytes", async () => {
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(
        new Uint8Array([1, 2, 3]),
      );

      const engine = createEngine();
      engine.start();

      let emissions = 0;
      engine.notebookDocChanged$.subscribe(() => {
        emissions++;
      });

      await engine.flushAndWait();
      expect(emissions).toBe(1);
      engine.stop();
    });

    it("fires delivery after flushAndWait succeeds", async () => {
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(
        new Uint8Array([1, 2, 3]),
      );

      const engine = createEngine();
      engine.start();

      let deliveries = 0;
      engine.notebookDocFlushDelivered$.subscribe(() => {
        deliveries++;
      });

      await engine.flushAndWait();
      expect(deliveries).toBe(1);
      engine.stop();
    });

    it("does not fire for runtime-state or comms doc sync events", () => {
      // ADR invariant: persist NotebookDoc bytes only. Output/widget churn
      // arrives as runtime_state/comms sync events and must never become
      // full-doc snapshot writes.
      (handle.receive_frame as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce([
          runtimeStateSyncEvent(
            makeRuntimeState({
              "exec-1": { status: "running", execution_count: 1, success: null },
            }),
          ),
        ])
        .mockReturnValueOnce([commsDocSyncEvent({ "comm-1": { value: 1 } })]);

      const engine = createEngine();
      engine.start();

      let emissions = 0;
      engine.notebookDocChanged$.subscribe(() => {
        emissions++;
      });

      transport.deliver(Array.from([0x05, 1]));
      transport.deliver(Array.from([0x09, 1]));
      expect(emissions).toBe(0);
      engine.stop();
    });

    it("does not fire when only non-notebook flushes produce bytes", () => {
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (handle.flush_runtime_state_sync as ReturnType<typeof vi.fn>).mockReturnValue(
        new Uint8Array([4, 5, 6]),
      );
      (handle.flush_comms_doc_sync as ReturnType<typeof vi.fn>).mockReturnValue(
        new Uint8Array([8, 9, 10]),
      );
      (handle.flush_pool_state_sync as ReturnType<typeof vi.fn>).mockReturnValue(
        new Uint8Array([7, 8, 9]),
      );

      const engine = createEngine();
      engine.start();

      let emissions = 0;
      engine.notebookDocChanged$.subscribe(() => {
        emissions++;
      });

      engine.flush();
      expect(emissions).toBe(0);
      engine.stop();
    });
  });

  // ── resetAndResync ────────────────────────────────────────────

  describe("resetAndResync", () => {
    it("resets sync state and flushes", () => {
      const syncMsg = new Uint8Array([7, 8, 9]);
      (handle.flush_local_changes as ReturnType<typeof vi.fn>).mockReturnValue(syncMsg);

      const engine = createEngine();
      engine.start();
      engine.resetAndResync();

      expect(handle.reset_sync_state).toHaveBeenCalled();
      expect(transport.sentFrames.length).toBeGreaterThanOrEqual(1);
      engine.stop();
    });
  });

  // ── resetForBootstrap ─────────────────────────────────────────

  describe("resetForBootstrap", () => {
    it("emits initialSyncComplete$ again after resetForBootstrap + interactive status", () => {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        sessionStatusEvent(interactiveStatus()),
      ]);

      const engine = createEngine();
      engine.start();

      // Track all emissions
      let emitCount = 0;
      engine.initialSyncComplete$.subscribe(() => {
        emitCount++;
      });

      transport.deliver(Array.from([0x07, 1]));
      expect(emitCount).toBe(1);

      // Simulate daemon:ready — reset for a new bootstrap cycle
      engine.resetForBootstrap();

      transport.deliver(Array.from([0x07, 2]));
      expect(emitCount).toBe(2);
      engine.stop();
    });

    it("continues emitting cellChanges$ before and after resetForBootstrap", () => {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockImplementation(() => {
        return [
          syncAppliedEvent({
            changed: true,
            changeset: {
              changed: [{ cell_id: "c1", fields: { source: true } }],
              added: [],
              removed: [],
              order_changed: false,
            },
          }),
        ];
      });

      const engine = createEngine();
      engine.start();

      let cellChangeCount = 0;
      engine.cellChanges$.subscribe(() => {
        cellChangeCount++;
      });

      // Bootstrap sync frames now flow through the normal materialization path.
      transport.deliver(Array.from([0x00, 1]));
      advanceBy(scheduler, 50);
      expect(cellChangeCount).toBe(1);

      transport.deliver(Array.from([0x07, 1]));
      transport.deliver(Array.from([0x00, 2]));
      advanceBy(scheduler, 50);
      expect(cellChangeCount).toBe(2);

      engine.resetForBootstrap();

      transport.deliver(Array.from([0x00, 3]));
      advanceBy(scheduler, 50);
      expect(cellChangeCount).toBe(3);
      engine.stop();
    });
  });

  // ── Null handle safety ────────────────────────────────────────

  describe("null handle", () => {
    it("does not crash when handle is null", () => {
      const nullEngine = new SyncEngine({
        getHandle: () => null,
        transport,
        presenceHeartbeat: {
          intervalMs: 15_000,
          encode: () => new Uint8Array([0]),
        },
        scheduler,
      });

      nullEngine.start();
      transport.deliver(Array.from([0x00, 1, 2, 3]));
      nullEngine.flush();
      nullEngine.scheduleFlush();
      nullEngine.resetAndResync();
      nullEngine.stop();
    });

    it("handle becomes null mid-pipeline after initial sync", () => {
      let returnHandle: SyncableHandle | null = handle;

      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        syncAppliedEvent({ changed: true }),
      ]);

      const engine = new SyncEngine({
        getHandle: () => returnHandle,
        transport,
        presenceHeartbeat: {
          intervalMs: 15_000,
          encode: () => new Uint8Array([0]),
        },
        scheduler,
      });
      engine.start();

      // Complete initial sync with valid handle
      transport.deliver(Array.from([0x00, 1]));

      // Now null out the handle
      returnHandle = null;

      // Deliver frame — should not crash
      transport.deliver(Array.from([0x00, 2]));
      advanceBy(scheduler, 50);

      // Flush — should not crash or send frames
      transport.clearSentFrames();
      engine.flush();
      expect(transport.sentFrames).toHaveLength(0);
      engine.stop();
    });
  });

  // ── Multicast (frameEvents$ share) ─────────────────────────────

  describe("frameEvents$ multicast", () => {
    it("delivers events to multiple subscribers via shared observable", () => {
      const broadcastPayload = { event: "kernel_status", status: "idle" };
      const presencePayload = { type: "update", peer: "alice" };

      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        broadcastEvent(broadcastPayload),
        presenceEvent(presencePayload),
      ]);

      const engine = createEngine();
      engine.start();

      const broadcasts: unknown[] = [];
      const presences: unknown[] = [];
      engine.broadcasts$.subscribe((p) => broadcasts.push(p));
      engine.presence$.subscribe((p) => presences.push(p));

      // Single frame produces both event types
      transport.deliver(Array.from([0x03, 1]));

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toEqual(broadcastPayload);
      expect(presences).toHaveLength(1);
      expect(presences[0]).toEqual(presencePayload);
      engine.stop();
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────

  describe("edge cases", () => {
    it("frame delivered after stop() does not crash or emit", () => {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        broadcastEvent({ event: "test" }),
      ]);

      const engine = createEngine();
      engine.start();

      const received: unknown[] = [];
      engine.broadcasts$.subscribe((p) => received.push(p));

      // Stop and then deliver — should not crash
      engine.stop();
      transport.deliver(Array.from([0x03, 1]));

      expect(received).toHaveLength(0);
    });
  });

  // ── Execution lifecycle transitions ────────────────────────────

  describe("execution lifecycle transitions", () => {
    // Registry to map frame bytes → FrameEvents for runtime state frames
    let runtimeStateFrameRegistry: Map<string, FrameEvent[]>;
    let runtimeStateFrameCounter: number;

    beforeEach(() => {
      runtimeStateFrameRegistry = new Map();
      runtimeStateFrameCounter = 0;
    });

    function deliverRuntimeState(state: RuntimeState): void {
      runtimeStateFrameCounter++;
      const frameBytes = [0x05, runtimeStateFrameCounter];
      const key = Array.from(frameBytes).join(",");
      runtimeStateFrameRegistry.set(key, [runtimeStateSyncEvent(state)]);
      transport.deliver(frameBytes);
    }

    /**
     * Helper: enter interactive state so the engine is in steady state.
     * Sets up handle.receive_frame to route runtime state frames via the registry,
     * and automerge sync frames through the standard steady-state path.
     */
    function setupWithInitialSync(): SyncEngine {
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockImplementation((bytes: Uint8Array) => {
        // Route based on frame type byte
        const frameType = bytes[0];

        if (frameType === 0x05) {
          // Runtime state sync frame — look up from registry
          const key = Array.from(bytes).join(",");
          const events = runtimeStateFrameRegistry.get(key);
          if (events) return events;
          return [];
        }

        if (frameType === 0x07) {
          return [sessionStatusEvent(interactiveStatus())];
        }

        return [syncAppliedEvent({ changed: true })];
      });

      const engine = createEngine();
      engine.start();

      transport.deliver(Array.from([0x07, 1]));

      return engine;
    }

    it("started transition emits execution transition without touching cellChanges$", () => {
      const engine = setupWithInitialSync();

      const cellEmissions: (CellChangeset | null)[] = [];
      const transitionEmissions: import("../src/runtime-state").ExecutionTransition[][] = [];
      engine.cellChanges$.subscribe((cs) => cellEmissions.push(cs));
      engine.executionTransitions$.subscribe((transitions) =>
        transitionEmissions.push(transitions),
      );

      // Deliver runtime state with a new "running" execution
      deliverRuntimeState(
        makeRuntimeState({
          e1: { status: "running", execution_count: 1, success: null },
        }),
      );

      // Flush scheduler past coalescing window
      advanceBy(scheduler, 50);

      expect(cellEmissions).toHaveLength(0);
      expect(transitionEmissions).toHaveLength(1);
      expect(transitionEmissions[0]).toEqual([
        { execution_id: "e1", kind: "started", execution_count: 1 },
      ]);
      engine.stop();
    });

    it("done transition emits execution transition", () => {
      const engine = setupWithInitialSync();

      // Deliver "running" first to establish prev state
      deliverRuntimeState(
        makeRuntimeState({
          e1: { status: "running", execution_count: 1, success: null },
        }),
      );

      // Flush past coalescing to clear the "started" emission
      advanceBy(scheduler, 50);

      const transitionEmissions: import("../src/runtime-state").ExecutionTransition[][] = [];
      engine.executionTransitions$.subscribe((transitions) =>
        transitionEmissions.push(transitions),
      );

      // Now deliver "done"
      deliverRuntimeState(
        makeRuntimeState({
          e1: { status: "done", execution_count: 1, success: true },
        }),
      );

      advanceBy(scheduler, 50);

      expect(transitionEmissions).toHaveLength(1);
      expect(transitionEmissions[0]).toEqual([
        { execution_id: "e1", kind: "done", execution_count: 1 },
      ]);
      engine.stop();
    });

    it("error transition emits execution transition", () => {
      const engine = setupWithInitialSync();

      // Deliver "running" first to establish prev state
      deliverRuntimeState(
        makeRuntimeState({
          e1: { status: "running", execution_count: 1, success: null },
        }),
      );

      // Flush past coalescing
      advanceBy(scheduler, 50);

      const transitionEmissions: import("../src/runtime-state").ExecutionTransition[][] = [];
      engine.executionTransitions$.subscribe((transitions) =>
        transitionEmissions.push(transitions),
      );

      // Now deliver "error"
      deliverRuntimeState(
        makeRuntimeState({
          e1: { status: "error", execution_count: 1, success: false },
        }),
      );

      advanceBy(scheduler, 50);

      expect(transitionEmissions).toHaveLength(1);
      expect(transitionEmissions[0]).toEqual([
        { execution_id: "e1", kind: "error", execution_count: 1 },
      ]);
      engine.stop();
    });

    it("multiple transitions in one update emit as one transition batch", () => {
      const engine = setupWithInitialSync();

      // Set up prev state with e2 running
      deliverRuntimeState(
        makeRuntimeState({
          e2: { status: "running", execution_count: 1, success: null },
        }),
      );

      // Flush past coalescing
      advanceBy(scheduler, 50);

      const transitionEmissions: import("../src/runtime-state").ExecutionTransition[][] = [];
      engine.executionTransitions$.subscribe((transitions) =>
        transitionEmissions.push(transitions),
      );

      // Deliver update with e1 newly started and e2 done
      deliverRuntimeState(
        makeRuntimeState({
          e1: { status: "running", execution_count: 2, success: null },
          e2: { status: "done", execution_count: 1, success: true },
        }),
      );

      advanceBy(scheduler, 50);

      expect(transitionEmissions).toHaveLength(1);
      expect(transitionEmissions[0]).toEqual([
        { execution_id: "e1", kind: "started", execution_count: 2 },
        { execution_id: "e2", kind: "done", execution_count: 1 },
      ]);
      engine.stop();
    });

    it("unchanged runtime state does not emit transitions", () => {
      const engine = setupWithInitialSync();

      const state = makeRuntimeState({
        e1: { status: "running", execution_count: 1, success: null },
      });

      // Deliver state first time
      deliverRuntimeState(state);

      // Flush past coalescing to process the first emission
      advanceBy(scheduler, 50);

      const transitionEmissions: import("../src/runtime-state").ExecutionTransition[][] = [];
      engine.executionTransitions$.subscribe((transitions) =>
        transitionEmissions.push(transitions),
      );

      // Deliver same state again — no transitions
      deliverRuntimeState(state);

      advanceBy(scheduler, 50);

      expect(transitionEmissions).toHaveLength(0);
      engine.stop();
    });

    it("runtime state transitions flow through even before initial sync completes", () => {
      // Set up handle that does NOT complete initial sync on automerge frames
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockImplementation((bytes: Uint8Array) => {
        const frameType = bytes[0];

        if (frameType === 0x05) {
          const key = Array.from(bytes).join(",");
          const events = runtimeStateFrameRegistry.get(key);
          if (events) return events;
          return [];
        }

        // Automerge sync — always changed:false (never completes initial sync)
        return [syncAppliedEvent({ changed: false })];
      });

      const engine = createEngine();
      engine.start();

      // Deliver a sync frame that does NOT complete initial sync
      transport.deliver(Array.from([0x00, 1]));

      const transitionEmissions: import("../src/runtime-state").ExecutionTransition[][] = [];
      engine.executionTransitions$.subscribe((transitions) =>
        transitionEmissions.push(transitions),
      );

      // Deliver runtime state with a transition — this should still flow through.
      deliverRuntimeState(
        makeRuntimeState({
          e1: { status: "running", execution_count: 1, success: null },
        }),
      );

      advanceBy(scheduler, 50);

      // Runtime state lifecycle transitions are NOT gated by initial sync.
      expect(transitionEmissions).toHaveLength(1);
      expect(transitionEmissions[0]).toEqual([
        { execution_id: "e1", kind: "started", execution_count: 1 },
      ]);
      engine.stop();
    });
  });

  // ── Sync error recovery ──────────────────────────────────────────

  describe("sync error recovery", () => {
    it("sends recovery reply on sync_error event", () => {
      const replyBytes = [0x01, 0x02, 0x03];
      handle = createMockHandle({
        receive_frame: vi.fn(() => [
          { type: "sync_error", changed: false, reply: replyBytes } as FrameEvent,
        ]),
      });
      const sendSpy = vi.spyOn(transport, "sendFrame");
      const engine = createEngine();
      engine.start();
      sendSpy.mockClear();

      transport.deliver([0x00, 0x99]);
      advanceBy(scheduler, 1);

      expect(sendSpy).toHaveBeenCalledWith(FrameType.AUTOMERGE_SYNC, new Uint8Array(replyBytes));
      engine.stop();
    });

    it("triggers full materialization when sync_error has changed=true", () => {
      handle = createMockHandle({
        receive_frame: vi.fn(() => [
          { type: "sync_error", changed: true, reply: [0x01] } as FrameEvent,
        ]),
      });
      const engine = createEngine();
      engine.start();

      const cellEmissions: (CellChangeset | null)[] = [];
      engine.cellChanges$.subscribe((cs) => cellEmissions.push(cs));

      transport.deliver([0x00, 0x99]);
      // Advance past the coalescing window (32ms)
      advanceBy(scheduler, 33); // past 32ms coalescing window

      // null = full materialization needed
      expect(cellEmissions).toHaveLength(1);
      expect(cellEmissions[0]).toBeNull();
      engine.stop();
    });

    it("does not complete initialSyncComplete$ on sync_error without session status", () => {
      handle = createMockHandle({
        receive_frame: vi.fn(() => [{ type: "sync_error", changed: true } as FrameEvent]),
      });
      const engine = createEngine();
      engine.start();

      let initialSyncCompleted = false;
      engine.initialSyncComplete$.subscribe(() => {
        initialSyncCompleted = true;
      });

      transport.deliver([0x00, 0x99]);
      advanceBy(scheduler, 1);

      expect(initialSyncCompleted).toBe(false);
      engine.stop();
    });

    it("sends recovery reply on runtime_state_sync_error event", () => {
      const replyBytes = [0x04, 0x05];
      handle = createMockHandle({
        receive_frame: vi.fn(() => [
          { type: "runtime_state_sync_error", changed: false, reply: replyBytes } as FrameEvent,
        ]),
      });
      const sendSpy = vi.spyOn(transport, "sendFrame");
      const engine = createEngine();
      engine.start();

      transport.deliver([0x05, 0x99]);
      advanceBy(scheduler, 1);

      expect(sendSpy).toHaveBeenCalledWith(
        FrameType.RUNTIME_STATE_SYNC,
        new Uint8Array(replyBytes),
      );
      engine.stop();
    });

    it("publishes runtime state on runtime_state_sync_error with changed=true", () => {
      const state = makeRuntimeState({
        e1: { status: "running", execution_count: 1, success: null },
      });
      handle = createMockHandle({
        receive_frame: vi.fn(() => [
          { type: "runtime_state_sync_error", changed: true, state, reply: [0x01] } as FrameEvent,
        ]),
      });
      const engine = createEngine();
      engine.start();

      const states: RuntimeState[] = [];
      engine.runtimeState$.subscribe((s) => states.push(s));

      transport.deliver([0x05, 0x99]);
      advanceBy(scheduler, 1);

      expect(states).toHaveLength(1);
      expect(states[0].executions["e1"].status).toBe("running");
      engine.stop();
    });

    it("calls cancel_last_flush if recovery reply send fails", async () => {
      const replyBytes = [0x01, 0x02];
      handle = createMockHandle({
        receive_frame: vi.fn(() => [
          { type: "sync_error", changed: false, reply: replyBytes } as FrameEvent,
        ]),
      });
      const engine = createEngine();
      engine.start();
      vi.spyOn(transport, "sendFrame").mockRejectedValueOnce(new Error("send failed"));

      transport.deliver([0x00, 0x99]);
      advanceBy(scheduler, 1);

      await vi.waitFor(() => {
        expect(handle.cancel_last_flush).toHaveBeenCalled();
      });
      engine.stop();
    });

    it("calls cancel_last_runtime_state_flush if state recovery reply fails", async () => {
      const replyBytes = [0x01, 0x02];
      handle = createMockHandle({
        receive_frame: vi.fn(() => [
          { type: "runtime_state_sync_error", changed: false, reply: replyBytes } as FrameEvent,
        ]),
      });
      const engine = createEngine();
      engine.start();
      vi.spyOn(transport, "sendFrame").mockRejectedValueOnce(new Error("send failed"));

      transport.deliver([0x05, 0x99]);
      advanceBy(scheduler, 1);

      await vi.waitFor(() => {
        expect(handle.cancel_last_runtime_state_flush).toHaveBeenCalled();
      });
      engine.stop();
    });

    it("handles sync_error with no reply and changed=false gracefully", () => {
      handle = createMockHandle({
        receive_frame: vi.fn(() => [{ type: "sync_error", changed: false } as FrameEvent]),
      });
      const engine = createEngine();
      engine.start();
      const sendSpy = vi.spyOn(transport, "sendFrame");

      transport.deliver([0x00, 0x99]);
      advanceBy(scheduler, 1);

      expect(sendSpy).not.toHaveBeenCalled();
      engine.stop();
    });
  });

  // ── Comm state projection + text-blob inlining ──────────────────

  describe("commChanges$ projection", () => {
    /**
     * Minimal runtime state with a single comm. The `CommDocEntry.state`
     * carries the raw blob-ref objects (what the daemon wrote into the
     * CRDT); `resolve_comm_state` on the handle is what the WASM side
     * uses to swap them for URL strings + path manifests.
     */
    function runtimeStateWithComm(
      commId: string,
      entryState: Record<string, unknown>,
    ): RuntimeState {
      const base = makeRuntimeState({});
      return {
        ...base,
        comms: {
          [commId]: {
            target_name: "jupyter.widget",
            model_module: "anywidget",
            model_name: "AnyModel",
            state: entryState,
            outputs: [],
            seq: 0,
          },
        },
      };
    }

    it("projects CommsDoc state changes against RuntimeStateDoc topology", async () => {
      const commId = "split-doc-comm";
      let resolvedState: Record<string, unknown> = { value: 0 };
      handle = createMockHandle({
        resolve_comm_state: vi.fn(() => ({
          state: resolvedState,
          buffer_paths: [] as string[][],
          text_paths: [] as string[][],
        })),
        generate_comms_doc_sync_reply: vi.fn(() => new Uint8Array([0xaa])),
      });

      const engine = createEngine();
      engine.start();

      const emissions: Array<{
        opened: Array<{ commId: string; state: unknown }>;
        updated: Array<{ commId: string; state: unknown }>;
      }> = [];
      engine.commChanges$.subscribe((c) => emissions.push(c));

      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        runtimeStateSyncEvent(runtimeStateWithComm(commId, {})),
      ]);
      transport.deliver([0x05, 0x01]);
      await vi.waitFor(() => expect(emissions.length).toBe(1));
      expect(emissions[0].opened.map((o) => o.commId)).toEqual([commId]);

      resolvedState = { value: 2 };
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        commsDocSyncEvent({ [commId]: { value: 2 } }),
      ]);
      transport.deliver([0x09, 0x02]);

      await vi.waitFor(() => expect(emissions.length).toBe(2));
      expect(emissions[1].updated.map((u) => u.commId)).toEqual([commId]);
      expect((emissions[1].updated[0].state as Record<string, unknown>).value).toBe(2);
      expect(
        transport.sentFrames.some(
          (frame) => frame.frameType === FrameType.COMMS_DOC_SYNC && frame.payload[0] === 0xaa,
        ),
      ).toBe(true);

      engine.stop();
    });

    it("projects plain CommsDoc JSON when the handle resolver is unavailable", async () => {
      const commId = "plain-json-comm";
      handle = createMockHandle({
        get_runtime_state: vi.fn(() => runtimeStateWithComm(commId, {})),
        get_comms_state: vi.fn(() => ({ comms: { [commId]: { value: 7 } } })),
        resolve_comm_state: vi.fn(() => undefined),
      });

      const engine = createEngine();
      engine.start();

      const emissions: Array<{
        opened: Array<{ commId: string; state: unknown }>;
        updated: Array<{ commId: string; state: unknown }>;
      }> = [];
      engine.commChanges$.subscribe((c) => emissions.push(c));
      engine.reProjectComms();

      await vi.waitFor(() => expect(emissions.length).toBe(1));
      expect(emissions[0].opened.map((o) => o.commId)).toEqual([commId]);
      expect((emissions[0].opened[0].state as Record<string, unknown>).value).toBe(7);

      engine.stop();
    });

    it("does not treat plain inline or blob traitlets as ContentRefs", async () => {
      const commId = "plain-content-ref-key-traitlet-comm";
      handle = createMockHandle({
        get_runtime_state: vi.fn(() => runtimeStateWithComm(commId, {})),
        get_comms_state: vi.fn(() => ({
          comms: {
            [commId]: {
              layout: { inline: true, display: "flex" },
              marker: { blob: "ordinary-traitlet" },
              payload: { blob: "ordinary-payload", size: 3, extra: "state" },
            },
          },
        })),
        resolve_comm_state: vi.fn(() => undefined),
      });

      const engine = createEngine();
      engine.start();

      const emissions: Array<{
        opened: Array<{ commId: string; state: unknown }>;
      }> = [];
      engine.commChanges$.subscribe((c) => emissions.push(c));
      engine.reProjectComms();

      await vi.waitFor(() => expect(emissions.length).toBe(1));
      expect(emissions[0].opened.map((o) => o.commId)).toEqual([commId]);
      expect(emissions[0].opened[0].state).toMatchObject({
        layout: { inline: true, display: "flex" },
        marker: { blob: "ordinary-traitlet" },
        payload: { blob: "ordinary-payload", size: 3, extra: "state" },
      });

      engine.stop();
    });

    it("replays the current comm projection for subscribers installed after bootstrap", async () => {
      const commId = "late-subscriber-comm";
      handle = createMockHandle({
        get_runtime_state: vi.fn(() => runtimeStateWithComm(commId, {})),
        get_comms_state: vi.fn(() => ({ comms: { [commId]: { value: 7 } } })),
        resolve_comm_state: vi.fn(() => ({
          state: { value: 7 },
          buffer_paths: [] as string[][],
          text_paths: [] as string[][],
        })),
      });

      const engine = createEngine();
      engine.start();

      // Cloud starts the engine while connecting the socket, then installs
      // React/widget-store subscribers after the runtime is returned. The
      // adapter must be able to replay the current durable comm projection
      // into those late subscribers, especially after reconnect.
      const emissions: Array<{
        opened: Array<{ commId: string; state: unknown }>;
        updated: Array<{ commId: string; state: unknown }>;
      }> = [];
      engine.commChanges$.subscribe((c) => emissions.push(c));
      const beforeReplay = emissions.length;
      engine.reProjectComms();

      await vi.waitFor(() => expect(emissions.length).toBeGreaterThan(beforeReplay));
      const replay = emissions.at(-1)!;
      expect(replay.opened.map((o) => o.commId)).toEqual([commId]);
      expect((replay.opened[0].state as Record<string, unknown>).value).toBe(7);

      engine.stop();
    });

    it("inlines text-MIME blobs into emitted comm state", async () => {
      const commId = "abc123";
      const pythonSource = "class Counter: count = 0";

      // handle.resolve_comm_state returns URLs + text_paths — same shape
      // as the WASM binding. The fetch mock completes that URL fetch.
      handle = createMockHandle({
        resolve_comm_state: vi.fn(() => ({
          state: {
            count: 0,
            _py_render: "http://127.0.0.1:1234/blob/pysrc",
          },
          buffer_paths: [] as string[][],
          text_paths: [["_py_render"]] as string[][],
        })),
      });

      const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/blob/pysrc")) {
          return new Response(pythonSource, { status: 200 });
        }
        return new Response("", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchStub);

      try {
        const engine = createEngine();
        engine.start();

        const emissions: Array<{ opened: Array<{ commId: string; state: unknown }> }> = [];
        engine.commChanges$.subscribe((c) => emissions.push(c));

        (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
          runtimeStateSyncEvent(runtimeStateWithComm(commId, { _py_render: "<blob-ref>" })),
        ]);
        transport.deliver([0x05, 0x01]);

        await vi.waitFor(() => {
          expect(emissions.length).toBeGreaterThan(0);
        });

        expect(fetchStub).toHaveBeenCalledTimes(1);
        expect(emissions[0].opened).toHaveLength(1);
        const openedState = emissions[0].opened[0].state as Record<string, unknown>;
        expect(openedState._py_render).toBe(pythonSource);
        expect(openedState.count).toBe(0);

        engine.stop();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("leaves binary-MIME blobs as URL strings", async () => {
      const commId = "bin1";
      handle = createMockHandle({
        resolve_comm_state: vi.fn(() => ({
          state: {
            image: "http://127.0.0.1:1234/blob/imghash",
          },
          buffer_paths: [["image"]] as string[][],
          text_paths: [] as string[][],
        })),
      });

      const fetchStub = vi.fn();
      vi.stubGlobal("fetch", fetchStub);

      try {
        const engine = createEngine();
        engine.start();

        const emissions: Array<{ opened: Array<{ commId: string; state: unknown }> }> = [];
        engine.commChanges$.subscribe((c) => emissions.push(c));

        (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
          runtimeStateSyncEvent(runtimeStateWithComm(commId, { image: "<blob-ref>" })),
        ]);
        transport.deliver([0x05, 0x02]);

        await vi.waitFor(() => {
          expect(emissions.length).toBeGreaterThan(0);
        });

        // Binary blobs must not be fetched — widgets resolve them via
        // blob-URL <img src> / ArrayBuffer fetch on their own.
        expect(fetchStub).not.toHaveBeenCalled();
        const openedState = emissions[0].opened[0].state as Record<string, unknown>;
        expect(openedState.image).toBe("http://127.0.0.1:1234/blob/imghash");

        engine.stop();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("retries transient 5xx errors and succeeds", async () => {
      // Uses `_py_render` (a pywidget-style text trait that really is
      // consumed as a literal string). `_esm` deliberately stays on
      // the URL path at the Rust level, so it never exercises the
      // text-inline retry code — see esm_blob_stays_as_url_not_text_inlined
      // in runtimed-wasm tests.
      const commId = "retry1";
      const payload = "loaded after retry";
      let attempts = 0;

      handle = createMockHandle({
        resolve_comm_state: vi.fn(() => ({
          state: { _py_render: "http://127.0.0.1:1234/blob/pysrc" },
          buffer_paths: [] as string[][],
          text_paths: [["_py_render"]] as string[][],
        })),
      });

      const fetchStub = vi.fn(async () => {
        attempts++;
        if (attempts === 1) {
          return new Response("temp err", { status: 503 });
        }
        return new Response(payload, { status: 200 });
      });
      vi.stubGlobal("fetch", fetchStub);

      try {
        const engine = createEngine();
        engine.start();

        const emissions: Array<{ opened: Array<{ commId: string; state: unknown }> }> = [];
        engine.commChanges$.subscribe((c) => emissions.push(c));

        (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
          runtimeStateSyncEvent(runtimeStateWithComm(commId, { _py_render: "<blob-ref>" })),
        ]);
        transport.deliver([0x05, 0x03]);

        // First fetch is immediate; the retry waits ~100ms of real time.
        await vi.waitFor(
          () => {
            expect(emissions.length).toBeGreaterThan(0);
          },
          { timeout: 2000 },
        );

        expect(attempts).toBe(2);
        const openedState = emissions[0].opened[0].state as Record<string, unknown>;
        expect(openedState._py_render).toBe(payload);

        engine.stop();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("does not fetch _esm — URL string passes through untouched", async () => {
      // Regression guard: `_esm` is excluded from text_paths in the Rust
      // resolver (see esm_blob_stays_as_url_not_text_inlined). The sync
      // engine must never issue a fetch for it — anywidget's loadESM
      // handles `import(url)` directly, and pulling the source here
      // defeats browser caching.
      const commId = "esm-passthrough";
      const esmUrl = "http://127.0.0.1:1234/blob/esmhash";

      handle = createMockHandle({
        resolve_comm_state: vi.fn(() => ({
          state: { _esm: esmUrl },
          buffer_paths: [["_esm"]] as string[][],
          text_paths: [] as string[][],
        })),
      });

      const fetchStub = vi.fn(() => Promise.resolve(new Response("unused")));
      vi.stubGlobal("fetch", fetchStub);

      try {
        const engine = createEngine();
        engine.start();

        const emissions: Array<{ opened: Array<{ commId: string; state: unknown }> }> = [];
        engine.commChanges$.subscribe((c) => emissions.push(c));

        (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
          runtimeStateSyncEvent(runtimeStateWithComm(commId, { _esm: "<blob-ref>" })),
        ]);
        transport.deliver([0x05, 0x06]);

        await vi.waitFor(() => {
          expect(emissions.length).toBeGreaterThan(0);
        });

        expect(fetchStub).not.toHaveBeenCalled();
        const openedState = emissions[0].opened[0].state as Record<string, unknown>;
        expect(openedState._esm).toBe(esmUrl);

        engine.stop();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("re-surfaces an update dropped while resolver was not ready", async () => {
      // Simulates the race where an update to an already-opened comm
      // arrives before blob/content resolution is ready
      // (resolve_comm_state returns undefined). Before the fix,
      // projectComms advanced the diff's recorded json for that comm,
      // so the next projection saw "no change" and never re-emitted —
      // the update was lost. Plain JSON states now fall back to raw
      // CommsDoc state; this test stays on a blob-backed state so it
      // still exercises the resolver-deferred path.
      const commId = "race1";
      let portReady = false;
      handle = createMockHandle({
        resolve_comm_state: vi.fn((_id: unknown) =>
          portReady
            ? {
                state: { image: "http://127.0.0.1:1234/blob/hash-b" },
                buffer_paths: [["image"]],
                text_paths: [],
              }
            : undefined,
        ),
      });

      const engine = createEngine();
      engine.start();

      const emissions: Array<{
        opened: Array<{ commId: string; state: unknown }>;
        updated: Array<{ commId: string; state: unknown }>;
      }> = [];
      engine.commChanges$.subscribe((c) => emissions.push(c));

      // Open: resolver ready, comm opens fine.
      portReady = true;
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        runtimeStateSyncEvent(runtimeStateWithComm(commId, { image: { blob: "hash-a", size: 1 } })),
      ]);
      transport.deliver([0x05, 0x01]);
      await vi.waitFor(() => expect(emissions.length).toBe(1));
      expect(emissions[0].opened.map((o) => o.commId)).toEqual([commId]);

      // Update arrives while resolver is briefly unavailable (e.g. port
      // reconnect). Before the fix, this update was swallowed and never
      // re-surfaced on later projections.
      portReady = false;
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        runtimeStateSyncEvent(runtimeStateWithComm(commId, { image: { blob: "hash-b", size: 1 } })),
      ]);
      transport.deliver([0x05, 0x02]);

      // Give the pipeline a turn — there should be no new emission yet.
      await Promise.resolve();
      expect(emissions.length).toBe(1);

      // Resolver comes back. Next projection should re-surface the
      // deferred update instead of comparing against the stale recorded
      // state and concluding "no change."
      portReady = true;
      (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
        runtimeStateSyncEvent(runtimeStateWithComm(commId, { image: { blob: "hash-b", size: 1 } })),
      ]);
      transport.deliver([0x05, 0x03]);

      await vi.waitFor(() => expect(emissions.length).toBe(2));
      expect(emissions[1].updated.map((u) => u.commId)).toEqual([commId]);

      engine.stop();
    });

    it("does not retry 4xx — leaves URL in state and emits anyway", async () => {
      const commId = "missing1";
      handle = createMockHandle({
        resolve_comm_state: vi.fn(() => ({
          state: { _py_render: "http://127.0.0.1:1234/blob/gone" },
          buffer_paths: [] as string[][],
          text_paths: [["_py_render"]] as string[][],
        })),
      });

      const fetchStub = vi.fn(async () => new Response("not found", { status: 404 }));
      vi.stubGlobal("fetch", fetchStub);

      try {
        const engine = createEngine();
        engine.start();

        const emissions: Array<{ opened: Array<{ commId: string; state: unknown }> }> = [];
        engine.commChanges$.subscribe((c) => emissions.push(c));

        (handle.receive_frame as ReturnType<typeof vi.fn>).mockReturnValue([
          runtimeStateSyncEvent(runtimeStateWithComm(commId, { _py_render: "<blob-ref>" })),
        ]);
        transport.deliver([0x05, 0x04]);

        await vi.waitFor(() => {
          expect(emissions.length).toBeGreaterThan(0);
        });

        expect(fetchStub).toHaveBeenCalledTimes(1); // no retry on 4xx
        const openedState = emissions[0].opened[0].state as Record<string, unknown>;
        // Fetch failed permanently — URL stays so downstream code at
        // least has a non-null value instead of discarding the emission.
        expect(openedState._py_render).toBe("http://127.0.0.1:1234/blob/gone");

        engine.stop();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // ── Local mutation apply (applyLocalMutationEvent) ───────────────

  describe("applyLocalMutationEvent", () => {
    it("routes a changed local mutation event without scheduling a flush", () => {
      const changeset: CellChangeset = {
        changed: [],
        added: ["cell-1"],
        removed: [],
        order_changed: true,
      };
      const executionViewChangeset: NonNullable<FrameEvent["execution_view_changeset"]> = {
        cell_pointer_changes: [["cell-1", "exec-1"]],
      };
      handle = createMockHandle({
        flush_local_changes: vi.fn(() => new Uint8Array([1])),
      });
      const engine = createEngine();
      engine.start();

      const cellEmissions: Array<CellChangeset | null> = [];
      engine.cellChanges$.subscribe((cs) => cellEmissions.push(cs));
      let docChanged = 0;
      engine.notebookDocChanged$.subscribe(() => docChanged++);
      let syncApplied = 0;
      engine.notebookSyncApplied$.subscribe(() => syncApplied++);
      const executionViewEmissions: NonNullable<FrameEvent["execution_view_changeset"]>[] = [];
      engine.executionViewChanges$.subscribe((cs) => executionViewEmissions.push(cs));
      const broadcasts: unknown[] = [];
      engine.broadcasts$.subscribe((b) => broadcasts.push(b));

      expect(
        engine.applyLocalMutationEvent(
          syncAppliedEvent({
            changed: true,
            changeset,
            attributions: [
              { cell_id: "cell-1", index: 0, text: "hi", deleted: 0, actors: ["user:test:alice"] },
            ],
            executionViewChangeset,
          }),
        ),
      ).toBe(true);

      advanceBy(scheduler, 50);
      expect(cellEmissions).toEqual([changeset]);
      expect(docChanged).toBe(1);
      expect(syncApplied).toBe(0);
      expect(executionViewEmissions).toEqual([executionViewChangeset]);
      expect(broadcasts).toHaveLength(1);
      expect(handle.flush_local_changes).not.toHaveBeenCalled();

      engine.stop();
    });

    it("returns false and emits nothing for missing, non-sync, or unchanged events", () => {
      const engine = createEngine();
      engine.start();

      const cellEmissions: Array<CellChangeset | null> = [];
      engine.cellChanges$.subscribe((cs) => cellEmissions.push(cs));
      let docChanged = 0;
      engine.notebookDocChanged$.subscribe(() => docChanged++);
      const executionViewEmissions: NonNullable<FrameEvent["execution_view_changeset"]>[] = [];
      engine.executionViewChanges$.subscribe((cs) => executionViewEmissions.push(cs));

      expect(engine.applyLocalMutationEvent(undefined)).toBe(false);
      expect(engine.applyLocalMutationEvent(null)).toBe(false);
      expect(engine.applyLocalMutationEvent(broadcastEvent({ ok: true }))).toBe(false);
      expect(
        engine.applyLocalMutationEvent(
          syncAppliedEvent({
            changed: false,
            executionViewChangeset: {
              cell_pointer_changes: [["cell-1", "exec-1"]],
            },
          }),
        ),
      ).toBe(false);

      advanceBy(scheduler, 100);
      expect(cellEmissions).toEqual([]);
      expect(docChanged).toBe(0);
      expect(executionViewEmissions).toEqual([]);
      expect(handle.flush_local_changes).not.toHaveBeenCalled();
      engine.stop();
    });

    it("returns false on a stopped engine", () => {
      const event = syncAppliedEvent({ changed: true });
      const engine = createEngine();

      expect(engine.applyLocalMutationEvent(event)).toBe(false);

      engine.start();
      engine.stop();
      expect(engine.applyLocalMutationEvent(event)).toBe(false);
    });
  });

  // ── Cross-tab apply (applyLocalPeerChanges) ─────────────────────

  describe("applyLocalPeerChanges", () => {
    it("routes a changed apply through the sync_applied pipeline and schedules a flush", () => {
      const changeset: CellChangeset = {
        changed: [],
        added: ["cell-1"],
        removed: [],
        order_changed: true,
      };
      const apply = vi.fn(() => syncAppliedEvent({ changed: true, changeset }));
      handle = createMockHandle({
        apply_change_bytes: apply,
        flush_local_changes: vi.fn(() => new Uint8Array([1])),
      });
      const engine = createEngine();
      engine.start();

      const cellEmissions: Array<CellChangeset | null> = [];
      engine.cellChanges$.subscribe((cs) => cellEmissions.push(cs));
      let docChanged = 0;
      engine.notebookDocChanged$.subscribe(() => docChanged++);
      let syncApplied = 0;
      engine.notebookSyncApplied$.subscribe(() => syncApplied++);

      const bytes = new Uint8Array([9, 9]);
      expect(engine.applyLocalPeerChanges(bytes)).toBe(true);
      expect(apply).toHaveBeenCalledWith(bytes);

      // Changeset rides the same coalescing buffer as inbound frames.
      advanceBy(scheduler, 50);
      expect(cellEmissions).toEqual([changeset]);
      // Persistence save hint fired from the apply path (and possibly
      // again from the scheduled flush attempt — both are by design;
      // persistence dedupes on heads).
      expect(docChanged).toBeGreaterThanOrEqual(1);
      // notebookSyncApplied$ reports applied ROOM frames only.
      expect(syncApplied).toBe(0);
      // The room stays authoritative: a changed apply schedules the
      // normal debounced outbound flush.
      expect(handle.flush_local_changes).toHaveBeenCalled();

      engine.stop();
    });

    it("emits nothing and schedules nothing for already-known changes (ping-pong terminator)", () => {
      const apply = vi.fn(() => syncAppliedEvent({ changed: false }));
      handle = createMockHandle({ apply_change_bytes: apply });
      const engine = createEngine();
      engine.start();

      const cellEmissions: Array<CellChangeset | null> = [];
      engine.cellChanges$.subscribe((cs) => cellEmissions.push(cs));
      let docChanged = 0;
      engine.notebookDocChanged$.subscribe(() => docChanged++);

      expect(engine.applyLocalPeerChanges(new Uint8Array([9]))).toBe(false);
      advanceBy(scheduler, 100);

      expect(cellEmissions).toEqual([]);
      expect(docChanged).toBe(0);
      expect(handle.flush_local_changes).not.toHaveBeenCalled();
      engine.stop();
    });

    it("drops (never half-applies) on a stopped engine", () => {
      const apply = vi.fn(() => syncAppliedEvent({ changed: true }));
      handle = createMockHandle({ apply_change_bytes: apply });
      const engine = createEngine();

      // Never started: the doc must NOT be mutated — applying with the
      // projection pipelines gone would silently lose the changeset and
      // the flush, with no way to backfill after start().
      expect(engine.applyLocalPeerChanges(new Uint8Array([1]))).toBe(false);
      expect(apply).not.toHaveBeenCalled();

      // Started then stopped: same contract.
      engine.start();
      engine.stop();
      expect(engine.applyLocalPeerChanges(new Uint8Array([1]))).toBe(false);
      expect(apply).not.toHaveBeenCalled();
    });

    it("returns false without throwing when the handle lacks the export or apply throws", () => {
      const engine = createEngine();
      engine.start();
      // No apply_change_bytes on the default mock handle:
      expect(engine.applyLocalPeerChanges(new Uint8Array([1]))).toBe(false);

      handle = createMockHandle({
        apply_change_bytes: vi.fn(() => {
          throw new Error("bad bytes");
        }),
      });
      expect(engine.applyLocalPeerChanges(new Uint8Array([1]))).toBe(false);
      engine.stop();

      // No handle at all:
      const engineNoHandle = createEngine({ getHandle: () => null });
      engineNoHandle.start();
      expect(engineNoHandle.applyLocalPeerChanges(new Uint8Array([1]))).toBe(false);
      engineNoHandle.stop();
    });

    it("broadcasts attributions from the apply, mirroring the inbound path", () => {
      const apply = vi.fn(() =>
        syncAppliedEvent({
          changed: true,
          attributions: [
            { cell_id: "cell-1", index: 0, text: "hi", deleted: 0, actors: ["user:test:alice"] },
          ],
        }),
      );
      handle = createMockHandle({ apply_change_bytes: apply });
      const engine = createEngine();
      engine.start();

      const broadcasts: unknown[] = [];
      engine.broadcasts$.subscribe((b) => broadcasts.push(b));
      engine.applyLocalPeerChanges(new Uint8Array([9]));

      expect(broadcasts).toHaveLength(1);
      engine.stop();
    });

    it("keeps routing execution-view changes even when peer changes are already known", () => {
      const executionViewChangeset: NonNullable<FrameEvent["execution_view_changeset"]> = {
        cell_pointer_changes: [["cell-1", "exec-1"]],
      };
      const apply = vi.fn(() =>
        syncAppliedEvent({
          changed: false,
          executionViewChangeset,
        }),
      );
      handle = createMockHandle({ apply_change_bytes: apply });
      const engine = createEngine();
      engine.start();

      const cellEmissions: Array<CellChangeset | null> = [];
      engine.cellChanges$.subscribe((cs) => cellEmissions.push(cs));
      let docChanged = 0;
      engine.notebookDocChanged$.subscribe(() => docChanged++);
      const executionViewEmissions: NonNullable<FrameEvent["execution_view_changeset"]>[] = [];
      engine.executionViewChanges$.subscribe((cs) => executionViewEmissions.push(cs));

      expect(engine.applyLocalPeerChanges(new Uint8Array([9]))).toBe(false);
      advanceBy(scheduler, 100);

      expect(cellEmissions).toEqual([]);
      expect(docChanged).toBe(0);
      expect(executionViewEmissions).toEqual([executionViewChangeset]);
      expect(handle.flush_local_changes).not.toHaveBeenCalled();
      engine.stop();
    });
  });
});

// ── DirectTransport tests ──────────────────────────────────────────

describe("DirectTransport", () => {
  it("delivers frames to subscribers", () => {
    const server = createMockServerHandle();
    const transport = new DirectTransport(server);

    const received: number[][] = [];
    transport.onFrame((payload) => received.push(payload));

    transport.deliver([0x00, 1, 2, 3]);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual([0x00, 1, 2, 3]);
  });

  it("unsubscribe removes listener", () => {
    const server = createMockServerHandle();
    const transport = new DirectTransport(server);

    const received: number[][] = [];
    const unsub = transport.onFrame((payload) => received.push(payload));

    transport.deliver([1]);
    unsub();
    transport.deliver([2]);

    expect(received).toHaveLength(1);
  });

  it("sendFrame records and routes to server", async () => {
    const server = createMockServerHandle();
    const transport = new DirectTransport(server);

    await transport.sendFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1, 2]));

    expect(transport.sentFrames).toHaveLength(1);
    expect(server.receive_sync_message).toHaveBeenCalledWith(new Uint8Array([1, 2]));
  });

  it("simulateFailure causes sendFrame to reject", async () => {
    const server = createMockServerHandle();
    const transport = new DirectTransport(server);

    transport.simulateFailure = true;

    await expect(
      transport.sendFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1])),
    ).rejects.toThrow("simulated send failure");

    expect(transport.sendFailureCount).toBe(1);
  });

  it("disconnect prevents further sends", async () => {
    const server = createMockServerHandle();
    const transport = new DirectTransport(server);

    transport.disconnect();
    expect(transport.connected).toBe(false);

    await expect(
      transport.sendFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1])),
    ).rejects.toThrow("not connected");
  });

  it("rejects outbound SESSION_CONTROL frames", async () => {
    const server = createMockServerHandle();
    const transport = new DirectTransport(server);

    await expect(
      transport.sendFrame(FrameType.SESSION_CONTROL, new Uint8Array([1])),
    ).rejects.toThrow("SESSION_CONTROL is server-originated only");
  });

  it("pushBroadcast delivers broadcast frame", () => {
    const server = createMockServerHandle();
    const transport = new DirectTransport(server);

    const received: number[][] = [];
    transport.onFrame((payload) => received.push(payload));

    transport.pushBroadcast({ event: "kernel_status", status: "idle" });

    expect(received).toHaveLength(1);
    expect(received[0][0]).toBe(FrameType.BROADCAST);
  });

  it("clearSentFrames resets history", async () => {
    const server = createMockServerHandle();
    const transport = new DirectTransport(server);

    await transport.sendFrame(FrameType.AUTOMERGE_SYNC, new Uint8Array([1]));
    expect(transport.sentFrames).toHaveLength(1);

    transport.clearSentFrames();
    expect(transport.sentFrames).toHaveLength(0);
  });
});

// ── mergeChangesets (moved from app, verify re-export) ────────────

describe("mergeChangesets", () => {
  it("merges two empty changesets", () => {
    const empty: CellChangeset = {
      changed: [],
      added: [],
      removed: [],
      order_changed: false,
    };
    const result = mergeChangesets(empty, empty);
    expect(result).toEqual(empty);
  });

  it("unions changed fields for the same cell", () => {
    const a: CellChangeset = {
      changed: [{ cell_id: "c1", fields: { source: true } }],
      added: [],
      removed: [],
      order_changed: false,
    };
    const b: CellChangeset = {
      changed: [{ cell_id: "c1", fields: { outputs: true } }],
      added: [],
      removed: [],
      order_changed: false,
    };
    const result = mergeChangesets(a, b);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].fields.source).toBe(true);
    expect(result.changed[0].fields.outputs).toBe(true);
  });

  it("deduplicates added/removed", () => {
    const a: CellChangeset = {
      changed: [],
      added: ["c1"],
      removed: ["c2"],
      order_changed: false,
    };
    const b: CellChangeset = {
      changed: [],
      added: ["c1", "c3"],
      removed: ["c2"],
      order_changed: true,
    };
    const result = mergeChangesets(a, b);
    expect(result.added).toEqual(["c1", "c3"]);
    expect(result.removed).toEqual(["c2"]);
    expect(result.order_changed).toBe(true);
  });
});

// ── diffExecutions (moved from app, verify re-export) ────────────

describe("diffExecutions", () => {
  it("detects started transition", () => {
    const prev = {};
    const curr = {
      e1: { status: "running" as const, execution_count: 1, success: null },
    };
    const transitions = diffExecutions(prev, curr);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].kind).toBe("started");
  });

  it("detects done transition", () => {
    const prev = {
      e1: { status: "running" as const, execution_count: 1, success: null },
    };
    const curr = {
      e1: { status: "done" as const, execution_count: 1, success: true },
    };
    const transitions = diffExecutions(prev, curr);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].kind).toBe("done");
  });

  it("detects error transition", () => {
    const prev = {
      e1: { status: "queued" as const, execution_count: null, success: null },
    };
    const curr = {
      e1: { status: "error" as const, execution_count: null, success: false },
    };
    const transitions = diffExecutions(prev, curr);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].kind).toBe("error");
  });

  it("detects cancelled transition for queued cells dropped behind an error", () => {
    const prev = {
      e1: { status: "queued" as const, execution_count: null, success: null },
    };
    const curr = {
      e1: { status: "cancelled" as const, execution_count: null, success: null },
    };
    const transitions = diffExecutions(prev, curr);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].kind).toBe("cancelled");
  });

  it("returns empty for no change", () => {
    const state = {
      e1: { status: "running" as const, execution_count: 1, success: null },
    };
    const transitions = diffExecutions(state, state);
    expect(transitions).toHaveLength(0);
  });

  it("detects execution_count arriving while still running", () => {
    const prev = {
      e1: { status: "running" as const, execution_count: null, success: null },
    };
    const curr = {
      e1: { status: "running" as const, execution_count: 5, success: null },
    };
    const transitions = diffExecutions(prev, curr);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].kind).toBe("started");
    expect(transitions[0].execution_count).toBe(5);
  });

  it("ignores execution_count change when not running", () => {
    const prev = {
      e1: { status: "done" as const, execution_count: null, success: true },
    };
    const curr = {
      e1: { status: "done" as const, execution_count: 5, success: true },
    };
    const transitions = diffExecutions(prev, curr);
    expect(transitions).toHaveLength(0);
  });
});
