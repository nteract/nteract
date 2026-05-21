import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Subject } from "rxjs";
import type {
  ExecutionViewChangeset,
  PoolState,
  RuntimeState,
  SessionStatus,
} from "runtimed";
import type { CellChangeset } from "../cell-changeset";
import {
  startNotebookSyncStoreBridge,
  type NotebookSyncStoreBridgeOptions,
} from "../notebook-sync-store-bridge";
import type { NotebookHandle } from "../../wasm/runtimed-wasm/runtimed_wasm.js";

const mocks = vi.hoisted(() => ({
  applyExecutionViewChangeset: vi.fn(),
  applyOutputChangeset: vi.fn(async () => {}),
  emitBroadcast: vi.fn(),
  emitPresence: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  materializeChangeset: vi.fn(async () => {}),
  notifyMetadataChanged: vi.fn(),
  seedOutputStoresFromHandle: vi.fn(),
  setPoolState: vi.fn(),
  setRuntimeState: vi.fn(),
}));

vi.mock("../frame-pipeline", () => ({
  materializeChangeset: mocks.materializeChangeset,
}));

vi.mock("../logger", () => ({
  logger: mocks.logger,
}));

vi.mock("../notebook-frame-bus", () => ({
  emitBroadcast: mocks.emitBroadcast,
  emitPresence: mocks.emitPresence,
}));

vi.mock("../notebook-metadata", () => ({
  notifyMetadataChanged: mocks.notifyMetadataChanged,
}));

vi.mock("../pool-state", () => ({
  setPoolState: mocks.setPoolState,
}));

vi.mock("../project-runtime-stores", () => ({
  applyExecutionViewChangeset: mocks.applyExecutionViewChangeset,
  applyOutputChangeset: mocks.applyOutputChangeset,
  seedOutputStoresFromHandle: mocks.seedOutputStoresFromHandle,
}));

vi.mock("../runtime-state", () => ({
  setRuntimeState: mocks.setRuntimeState,
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function readyStatus(): SessionStatus {
  return {
    notebook_doc: "interactive",
    runtime_state: "ready",
    initial_load: { phase: "ready" },
  };
}

function streamingStatus(): SessionStatus {
  return {
    notebook_doc: "interactive",
    runtime_state: "ready",
    initial_load: { phase: "streaming" },
  };
}

function failedStatus(reason = "load failed"): SessionStatus {
  return {
    notebook_doc: "interactive",
    runtime_state: "ready",
    initial_load: { phase: "failed", reason },
  };
}

function createHandle() {
  return {
    get_cell_ids: vi.fn(() => ["cell-1"]),
    get_cell_execution_id: vi.fn(() => "exec-1"),
    get_cell_outputs: vi.fn(() => [{ output_id: "out-1", output_type: "stream" }]),
  } as unknown as NotebookHandle;
}

function createEngineSubjects() {
  const subjects = {
    broadcasts$: new Subject<unknown>(),
    cellChanges$: new Subject<CellChangeset | null>(),
    executionViewChanges$: new Subject<ExecutionViewChangeset>(),
    initialSyncComplete$: new Subject<void>(),
    outputIdChanges$: new Subject<{ changed: Array<[string, unknown]>; removed_ids: string[] }>(),
    poolState$: new Subject<PoolState>(),
    presence$: new Subject<unknown>(),
    runtimeState$: new Subject<RuntimeState>(),
    sessionStatus$: new Subject<SessionStatus>(),
  };

  const engine = Object.fromEntries(
    Object.entries(subjects).map(([key, subject]) => [key, subject.asObservable()]),
  ) as NotebookSyncStoreBridgeOptions["engine"];

  return { engine, subjects };
}

function startBridge(
  overrides: Partial<NotebookSyncStoreBridgeOptions> = {},
) {
  const { engine, subjects } = createEngineSubjects();
  const handle = createHandle();
  const materializeCells = vi.fn(async () => {});
  const projection: ExecutionViewChangeset = {
    execution_upserts: [
      [
        "exec-1",
        {
          execution_count: 1,
          output_ids: ["out-1"],
          status: "done",
          success: true,
        },
      ],
    ],
  };
  const projectExecutionViewChangeset = vi.fn(() => projection);
  const refreshCanAcceptCellMutations = vi.fn(() => true);
  const setIsLoading = vi.fn();
  const setLoadError = vi.fn();

  const options: NotebookSyncStoreBridgeOptions = {
    engine,
    getHandle: () => handle,
    materializeCells,
    outputCache: new Map(),
    projectExecutionViewChangeset,
    refreshCanAcceptCellMutations,
    setIsLoading,
    setLoadError,
    ...overrides,
  };

  const bridge = startNotebookSyncStoreBridge(options);
  return {
    bridge,
    handle,
    materializeCells,
    options,
    projectExecutionViewChangeset,
    refreshCanAcceptCellMutations,
    setIsLoading,
    setLoadError,
    subjects,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyOutputChangeset.mockResolvedValue(undefined);
  mocks.materializeChangeset.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("startNotebookSyncStoreBridge", () => {
  it("sets load error and clears loading when initial load fails", () => {
    const { bridge, setIsLoading, setLoadError, subjects } = startBridge();

    subjects.sessionStatus$.next(failedStatus("trust required"));

    expect(setLoadError).toHaveBeenCalledWith("trust required");
    expect(setIsLoading).toHaveBeenCalledWith(false);

    bridge.stop();
  });

  it("materializes and seeds app stores when initial sync becomes interactive", async () => {
    const {
      bridge,
      handle,
      materializeCells,
      projectExecutionViewChangeset,
      refreshCanAcceptCellMutations,
      setIsLoading,
      subjects,
    } = startBridge();

    subjects.sessionStatus$.next(readyStatus());
    subjects.initialSyncComplete$.next();
    await flushMicrotasks();

    expect(materializeCells).toHaveBeenCalledWith(handle);
    expect(projectExecutionViewChangeset).toHaveBeenCalledWith(handle);
    expect(mocks.applyExecutionViewChangeset).toHaveBeenCalledWith(
      projectExecutionViewChangeset.mock.results[0].value,
    );
    expect(mocks.seedOutputStoresFromHandle).toHaveBeenCalledWith(handle, ["cell-1"]);
    expect(refreshCanAcceptCellMutations).toHaveBeenCalledWith(handle);
    expect(setIsLoading).toHaveBeenLastCalledWith(false);
    expect(mocks.notifyMetadataChanged).toHaveBeenCalledTimes(1);

    bridge.stop();
  });

  it("reports materialization failures and clears loading", async () => {
    const error = new Error("materialize failed");
    const materializeCells = vi.fn(async () => {
      throw error;
    });
    const { bridge, setIsLoading, setLoadError, subjects } = startBridge({ materializeCells });

    subjects.initialSyncComplete$.next();
    await flushMicrotasks();

    expect(setLoadError).toHaveBeenCalledWith("materialize failed");
    expect(setIsLoading).toHaveBeenCalledWith(false);

    bridge.stop();
  });

  it("serializes cell changes and refreshes execution projection after each batch", async () => {
    const first = deferred();
    const second = deferred();
    mocks.materializeChangeset
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const {
      bridge,
      handle,
      options,
      projectExecutionViewChangeset,
      refreshCanAcceptCellMutations,
      subjects,
    } = startBridge();

    const changeset: CellChangeset = {
      added: [],
      changed: [{ cell_id: "cell-1", fields: { source: true } }],
      order_changed: false,
      removed: [],
    };
    subjects.cellChanges$.next(changeset);
    subjects.cellChanges$.next(null);

    expect(mocks.materializeChangeset).toHaveBeenCalledTimes(1);
    expect(mocks.materializeChangeset).toHaveBeenCalledWith(changeset, {
      getHandle: options.getHandle,
      materializeCells: options.materializeCells,
      outputCache: options.outputCache,
    });

    first.resolve();
    await flushMicrotasks();

    expect(mocks.materializeChangeset).toHaveBeenCalledTimes(2);
    expect(mocks.materializeChangeset).toHaveBeenLastCalledWith(null, {
      getHandle: options.getHandle,
      materializeCells: options.materializeCells,
      outputCache: options.outputCache,
    });

    second.resolve();
    await flushMicrotasks();

    expect(refreshCanAcceptCellMutations).toHaveBeenCalledWith(handle);
    expect(projectExecutionViewChangeset).toHaveBeenCalledTimes(2);
    expect(mocks.applyExecutionViewChangeset).toHaveBeenCalledTimes(2);

    bridge.stop();
  });

  it("routes sync engine streams to app stores and frame buses", async () => {
    const { bridge, subjects } = startBridge();
    const runtimeState = { kernel: null } as RuntimeState;
    const poolState = { uv: {}, conda: {}, pixi: {} } as PoolState;
    const executionChanges: ExecutionViewChangeset = {
      cell_pointer_changes: [["cell-1", "exec-1"]],
    };

    subjects.broadcasts$.next({ type: "broadcast" });
    subjects.presence$.next({ type: "presence" });
    subjects.runtimeState$.next(runtimeState);
    subjects.poolState$.next(poolState);
    subjects.executionViewChanges$.next(executionChanges);
    subjects.outputIdChanges$.next({
      changed: [["out-1", { output_type: "stream" }]],
      removed_ids: ["out-old"],
    });
    await flushMicrotasks();

    expect(mocks.emitBroadcast).toHaveBeenCalledWith({ type: "broadcast" });
    expect(mocks.emitPresence).toHaveBeenCalledWith({ type: "presence" });
    expect(mocks.setRuntimeState).toHaveBeenCalledWith(runtimeState);
    expect(mocks.setPoolState).toHaveBeenCalledWith(poolState);
    expect(mocks.applyExecutionViewChangeset).toHaveBeenCalledWith(executionChanges);
    expect(mocks.applyOutputChangeset).toHaveBeenCalledWith(
      [["out-1", { output_type: "stream" }]],
      ["out-old"],
    );

    bridge.stop();
  });

  it("resetReadiness prevents later session status from changing loading before rematerialization", async () => {
    const { bridge, setIsLoading, subjects } = startBridge();

    subjects.initialSyncComplete$.next();
    await flushMicrotasks();
    setIsLoading.mockClear();

    subjects.sessionStatus$.next(streamingStatus());
    expect(setIsLoading).toHaveBeenCalledWith(true);

    bridge.resetReadiness();
    setIsLoading.mockClear();
    subjects.sessionStatus$.next(streamingStatus());
    expect(setIsLoading).not.toHaveBeenCalled();

    bridge.stop();
  });

  it("unsubscribes all app-store routes when stopped", async () => {
    const { bridge, subjects } = startBridge();

    bridge.stop();
    vi.clearAllMocks();

    subjects.sessionStatus$.next(failedStatus());
    subjects.initialSyncComplete$.next();
    subjects.cellChanges$.next(null);
    subjects.broadcasts$.next({ type: "broadcast" });
    subjects.presence$.next({ type: "presence" });
    subjects.runtimeState$.next({ kernel: null } as RuntimeState);
    subjects.poolState$.next({ uv: {}, conda: {}, pixi: {} } as PoolState);
    subjects.executionViewChanges$.next({});
    subjects.outputIdChanges$.next({ changed: [["out-1", {}]], removed_ids: [] });
    await flushMicrotasks();

    expect(mocks.materializeChangeset).not.toHaveBeenCalled();
    expect(mocks.emitBroadcast).not.toHaveBeenCalled();
    expect(mocks.emitPresence).not.toHaveBeenCalled();
    expect(mocks.setRuntimeState).not.toHaveBeenCalled();
    expect(mocks.setPoolState).not.toHaveBeenCalled();
    expect(mocks.applyExecutionViewChangeset).not.toHaveBeenCalled();
    expect(mocks.applyOutputChangeset).not.toHaveBeenCalled();
  });
});
