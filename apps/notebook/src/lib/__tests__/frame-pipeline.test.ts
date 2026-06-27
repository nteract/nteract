import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { JupyterOutput } from "../../types";
import {
  type CellChangeset,
  type ChangedFields,
  mergeChangesets,
} from "../cell-changeset";
import {
  type MaterializeDeps,
  materializeChangeset,
  publishProgressiveInitialStructureSlice,
} from "../frame-pipeline";

// ── Mocks ──────────────────────────────────────────────────────────────

// Mock notebook-cells: getCellById returns a stored cell, updateCellById
// captures what the pipeline writes to the store.
const cellStore = new Map<string, Record<string, unknown>>();
const updateCalls: Array<{ cellId: string; cell: Record<string, unknown> }> =
  [];
const structureProjectionCalls: Array<{
  orderedCellIds: string[];
  upsertedCells?: Array<Record<string, unknown>>;
}> = [];

vi.mock("../notebook-cells", () => ({
  getCellById: (id: string) => cellStore.get(id) ?? null,
  getCellIdsSnapshot: () => [...cellStore.keys()],
  updateCellById: (
    id: string,
    fn: (prev: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const prev = cellStore.get(id) ?? {};
    const next = fn(prev);
    cellStore.set(id, next);
    updateCalls.push({ cellId: id, cell: next });
  },
}));

vi.mock("@/components/notebook/state/cell-store", () => ({
  applyNotebookCellStructureProjection: ({
    orderedCellIds,
    upsertedCells = [],
  }: {
    orderedCellIds: string[];
    upsertedCells?: Array<Record<string, unknown>>;
  }) => {
    structureProjectionCalls.push({ orderedCellIds, upsertedCells });
    const finalIds = new Set(orderedCellIds);
    for (const cell of upsertedCells) {
      if (typeof cell.id === "string" && finalIds.has(cell.id)) {
        cellStore.set(cell.id, cell);
      }
    }
    for (const id of [...cellStore.keys()]) {
      if (!finalIds.has(id)) cellStore.delete(id);
    }
  },
}));

vi.mock("../notebook-metadata", () => ({
  notifyMetadataChanged: vi.fn(),
}));

vi.mock("../blob-port", () => ({
  getBlobResolver: () => null,
  getBlobPort: () => 12345,
  refreshBlobPort: () => Promise.resolve(12345),
}));

vi.mock("../logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock materialize-cells: materializeCellFromWasm builds a cell from the
// handle's per-field accessors. outputCacheKey and resolveOutput handle
// the cache-miss path.
function mockOutputCacheKey(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

vi.mock("../materialize-cells", () => ({
  outputCacheKey: (output: unknown) => mockOutputCacheKey(output),
  materializeCellFromWasm: (
    handle: Record<string, (id: string) => unknown>,
    cellId: string,
    cache: Map<string, JupyterOutput>,
    _prev?: Record<string, unknown>,
    _blobPort?: number | null,
  ) => {
    const cellType = handle.get_cell_type(cellId);
    if (!cellType) return null;
    const source = (handle.get_cell_source(cellId) as string) ?? "";
    const ecStr = handle.get_cell_execution_count(cellId) as string;
    const ec = !ecStr || ecStr === "null" ? null : Number.parseInt(ecStr, 10);
    const rawOutputs = (handle.get_cell_outputs(cellId) as unknown[]) ?? [];
    const outputs = rawOutputs
      .map((o: unknown) => cache.get(mockOutputCacheKey(o)) ?? null)
      .filter((o: JupyterOutput | null): o is JupyterOutput => o !== null);
    const metadata =
      (handle.get_cell_metadata(cellId) as Record<string, unknown>) ?? {};
    return {
      id: cellId,
      cell_type: cellType,
      source,
      execution_count: ec,
      outputs,
      metadata,
    };
  },
  resolveOutput: async (
    output: unknown,
    _blobPort: number,
    cache: Map<string, JupyterOutput>,
  ) => {
    // Simulate async resolution — check cache, test-level registry,
    // or handle objects/strings.
    const key = mockOutputCacheKey(output);
    const cached = cache.get(key);
    if (cached) return cached;
    // Check test-level registry for manifest objects (keyed by JSON)
    const registered = blobRegistry.get(key);
    if (registered) {
      cache.set(key, registered);
      return registered;
    }
    // Object with output_type — treat as raw JupyterOutput
    if (
      typeof output === "object" &&
      output !== null &&
      "output_type" in output
    ) {
      const jupyterOutput = output as JupyterOutput;
      cache.set(key, jupyterOutput);
      return jupyterOutput;
    }
    // String — try JSON.parse
    if (typeof output === "string") {
      try {
        const parsed = JSON.parse(output) as JupyterOutput;
        cache.set(key, parsed);
        return parsed;
      } catch {
        return null;
      }
    }
    return null;
  },
}));

// Test-level registry for simulating blob server responses for manifest objects.
const blobRegistry = new Map<string, JupyterOutput>();

// ---------------------------------------------------------------------------
// mergeChangesets — merges two CellChangesets produced by successive WASM
// sync frames within a coalescing window.
// ---------------------------------------------------------------------------

describe("mergeChangesets", () => {
  const empty: CellChangeset = {
    changed: [],
    added: [],
    removed: [],
    order_changed: false,
  };

  it("merges two empty changesets", () => {
    const result = mergeChangesets(empty, empty);
    expect(result).toEqual(empty);
  });

  it("merges when first changeset is empty", () => {
    const b: CellChangeset = {
      changed: [{ cell_id: "c1", fields: { source: true } }],
      added: ["c2"],
      removed: [],
      order_changed: false,
    };
    const result = mergeChangesets(empty, b);
    expect(result.changed).toEqual([
      { cell_id: "c1", fields: { source: true } },
    ]);
    expect(result.added).toEqual(["c2"]);
  });

  it("merges when second changeset is empty", () => {
    const a: CellChangeset = {
      changed: [{ cell_id: "c1", fields: { outputs: true } }],
      added: [],
      removed: ["c3"],
      order_changed: true,
    };
    const result = mergeChangesets(a, empty);
    expect(result.changed).toEqual([
      { cell_id: "c1", fields: { outputs: true } },
    ]);
    expect(result.removed).toEqual(["c3"]);
    expect(result.order_changed).toBe(true);
  });

  it("unions changed fields for the same cell_id", () => {
    const a: CellChangeset = {
      changed: [{ cell_id: "c1", fields: { source: true } }],
      added: [],
      removed: [],
      order_changed: false,
    };
    const b: CellChangeset = {
      changed: [
        { cell_id: "c1", fields: { outputs: true, execution_count: true } },
      ],
      added: [],
      removed: [],
      order_changed: false,
    };
    const result = mergeChangesets(a, b);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].cell_id).toBe("c1");
    expect(result.changed[0].fields).toEqual({
      source: true,
      outputs: true,
      execution_count: true,
    });
  });

  it("keeps distinct cells separate", () => {
    const a: CellChangeset = {
      changed: [{ cell_id: "c1", fields: { source: true } }],
      added: [],
      removed: [],
      order_changed: false,
    };
    const b: CellChangeset = {
      changed: [{ cell_id: "c2", fields: { metadata: true } }],
      added: [],
      removed: [],
      order_changed: false,
    };
    const result = mergeChangesets(a, b);
    expect(result.changed).toHaveLength(2);
    const ids = result.changed.map((c) => c.cell_id).sort();
    expect(ids).toEqual(["c1", "c2"]);
  });

  it("deduplicates added cell IDs", () => {
    const a: CellChangeset = {
      changed: [],
      added: ["c1", "c2"],
      removed: [],
      order_changed: false,
    };
    const b: CellChangeset = {
      changed: [],
      added: ["c2", "c3"],
      removed: [],
      order_changed: false,
    };
    const result = mergeChangesets(a, b);
    expect(result.added).toEqual(["c1", "c2", "c3"]);
  });

  it("deduplicates removed cell IDs", () => {
    const a: CellChangeset = {
      changed: [],
      added: [],
      removed: ["c1"],
      order_changed: false,
    };
    const b: CellChangeset = {
      changed: [],
      added: [],
      removed: ["c1", "c2"],
      order_changed: false,
    };
    const result = mergeChangesets(a, b);
    expect(result.removed).toEqual(["c1", "c2"]);
  });

  it("propagates order_changed if either is true", () => {
    const a: CellChangeset = {
      changed: [],
      added: [],
      removed: [],
      order_changed: false,
    };
    const b: CellChangeset = {
      changed: [],
      added: [],
      removed: [],
      order_changed: true,
    };
    expect(mergeChangesets(a, b).order_changed).toBe(true);
    expect(mergeChangesets(b, a).order_changed).toBe(true);
    expect(mergeChangesets(b, b).order_changed).toBe(true);
    expect(mergeChangesets(a, a).order_changed).toBe(false);
  });

  it("does not set false fields when merging overlapping field keys", () => {
    // If both changesets mark the same field as true, result should be true.
    // If only one does, the field should still be true (union, not intersection).
    const a: CellChangeset = {
      changed: [{ cell_id: "c1", fields: { source: true, outputs: true } }],
      added: [],
      removed: [],
      order_changed: false,
    };
    const b: CellChangeset = {
      changed: [{ cell_id: "c1", fields: { source: true, metadata: true } }],
      added: [],
      removed: [],
      order_changed: false,
    };
    const result = mergeChangesets(a, b);
    const fields = result.changed[0].fields;
    expect(fields.source).toBe(true);
    expect(fields.outputs).toBe(true);
    expect(fields.metadata).toBe(true);
  });

  it("handles all ChangedFields keys", () => {
    const allFields: ChangedFields = {
      source: true,
      outputs: true,
      execution_count: true,
      cell_type: true,
      metadata: true,
      position: true,
      resolved_assets: true,
    };
    const a: CellChangeset = {
      changed: [{ cell_id: "c1", fields: { source: true, outputs: true } }],
      added: [],
      removed: [],
      order_changed: false,
    };
    const b: CellChangeset = {
      changed: [
        {
          cell_id: "c1",
          fields: {
            execution_count: true,
            cell_type: true,
            metadata: true,
            position: true,
            resolved_assets: true,
          },
        },
      ],
      added: [],
      removed: [],
      order_changed: false,
    };
    const result = mergeChangesets(a, b);
    expect(result.changed[0].fields).toEqual(allFields);
  });

  it("does not mutate input changesets", () => {
    const a: CellChangeset = {
      changed: [{ cell_id: "c1", fields: { source: true } }],
      added: ["c2"],
      removed: [],
      order_changed: false,
    };
    const b: CellChangeset = {
      changed: [{ cell_id: "c1", fields: { outputs: true } }],
      added: ["c3"],
      removed: ["c4"],
      order_changed: true,
    };

    // Snapshot originals
    const aJson = JSON.stringify(a);
    const bJson = JSON.stringify(b);

    mergeChangesets(a, b);

    expect(JSON.stringify(a)).toBe(aJson);
    expect(JSON.stringify(b)).toBe(bJson);
  });

  it("handles many cells across multiple merges (chained)", () => {
    let acc = empty;
    for (let i = 0; i < 100; i++) {
      const cs: CellChangeset = {
        changed: [{ cell_id: `c${i}`, fields: { source: true } }],
        added: i % 10 === 0 ? [`new-${i}`] : [],
        removed: [],
        order_changed: false,
      };
      acc = mergeChangesets(acc, cs);
    }
    expect(acc.changed).toHaveLength(100);
    expect(acc.added).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// materializeChangeset — processes coalesced CellChangesets from the
// SyncEngine and writes the resulting cells to the React store.
// ---------------------------------------------------------------------------

describe("materializeChangeset", () => {
  // Mock handle factory
  function createMockHandle(
    cells: Record<
      string,
      {
        type?: string;
        source?: string;
        outputs?: unknown[];
        execution_count?: string;
        metadata?: Record<string, unknown>;
      }
    >,
    orderedCellIds = Object.keys(cells),
  ) {
    return {
      get_cell_ids: vi.fn(() => orderedCellIds),
      get_cell_type: vi.fn((id: string) =>
        Object.prototype.hasOwnProperty.call(cells, id)
          ? (cells[id]?.type ?? "code")
          : null,
      ),
      get_cell_source: vi.fn((id: string) => cells[id]?.source ?? ""),
      get_cell_outputs: vi.fn((id: string) => cells[id]?.outputs ?? []),
      get_cell_execution_count: vi.fn(
        (id: string) => cells[id]?.execution_count ?? "null",
      ),
      get_cell_metadata: vi.fn((id: string) => cells[id]?.metadata ?? {}),
    } as unknown as import("../../wasm/runtimed-wasm/runtimed_wasm.js").NotebookHandle;
  }

  function createDeps(
    handle: ReturnType<typeof createMockHandle>,
    outputCache?: Map<string, JupyterOutput>,
  ): MaterializeDeps {
    return {
      getHandle: () => handle,
      materializeCells: vi.fn(),
      outputCache: outputCache ?? new Map(),
    };
  }

  beforeEach(() => {
    cellStore.clear();
    updateCalls.length = 0;
    structureProjectionCalls.length = 0;
    blobRegistry.clear();
  });

  it("clears cell when WASM returns empty outputs", async () => {
    const handle = createMockHandle({
      c1: { outputs: [], execution_count: "null" },
    });
    const deps = createDeps(handle);

    await materializeChangeset(
      {
        changed: [
          { cell_id: "c1", fields: { outputs: true, execution_count: true } },
        ],
        added: [],
        removed: [],
        order_changed: false,
      },
      deps,
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].cellId).toBe("c1");
    expect(updateCalls[0].cell).toMatchObject({
      outputs: [],
      execution_count: null,
    });
  });

  it("restores final outputs from WASM via cache", async () => {
    const streamOutput: JupyterOutput = {
      output_type: "stream",
      name: "stdout",
      text: "hello\n",
    };
    const cache = new Map<string, JupyterOutput>();
    cache.set("out-hash-1", streamOutput);

    const handle = createMockHandle({
      c1: { outputs: ["out-hash-1"], execution_count: "5" },
    });
    const deps = createDeps(handle, cache);

    await materializeChangeset(
      {
        changed: [
          { cell_id: "c1", fields: { outputs: true, execution_count: true } },
        ],
        added: [],
        removed: [],
        order_changed: false,
      },
      deps,
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].cell).toMatchObject({
      outputs: [streamOutput],
      execution_count: 5,
    });
  });

  it("preserves source when fields.source is false", async () => {
    // Pre-populate store with existing source
    cellStore.set("c1", {
      id: "c1",
      cell_type: "code",
      source: "print('original')",
      outputs: [],
      execution_count: null,
      metadata: {},
    });

    const handle = createMockHandle({
      c1: {
        source: "print('from-wasm')",
        outputs: [],
        execution_count: "3",
      },
    });
    const deps = createDeps(handle);

    await materializeChangeset(
      {
        changed: [
          {
            cell_id: "c1",
            fields: { outputs: true, execution_count: true },
            // source is NOT in fields — should preserve store source
          },
        ],
        added: [],
        removed: [],
        order_changed: false,
      },
      deps,
    );

    expect(updateCalls).toHaveLength(1);
    // Source should be the original from the store, not from WASM
    expect(updateCalls[0].cell.source).toBe("print('original')");
  });

  it("restores error output on reconciliation", async () => {
    const errorOutput: JupyterOutput = {
      output_type: "error",
      ename: "ZeroDivisionError",
      evalue: "division by zero",
      traceback: ["Traceback...", "ZeroDivisionError: division by zero"],
    };
    const cache = new Map<string, JupyterOutput>();
    cache.set("err-hash-1", errorOutput);

    const handle = createMockHandle({
      c1: { outputs: ["err-hash-1"], execution_count: "2" },
    });
    const deps = createDeps(handle, cache);

    await materializeChangeset(
      {
        changed: [
          { cell_id: "c1", fields: { outputs: true, execution_count: true } },
        ],
        added: [],
        removed: [],
        order_changed: false,
      },
      deps,
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].cell.outputs).toEqual([errorOutput]);
    expect(updateCalls[0].cell.execution_count).toBe(2);
  });

  it("falls back to full materialization for null changeset", async () => {
    const handle = createMockHandle({});
    const deps = createDeps(handle);

    await materializeChangeset(null, deps);

    expect(deps.materializeCells).toHaveBeenCalledWith(handle);
  });

  it("projects a pure insert by materializing exactly the new final cell", async () => {
    const existingA = {
      id: "a",
      cell_type: "code",
      source: "keep-a",
      outputs: [],
      execution_count: null,
      metadata: {},
    };
    const existingB = {
      id: "b",
      cell_type: "code",
      source: "keep-b",
      outputs: [],
      execution_count: null,
      metadata: {},
    };
    cellStore.set("a", existingA);
    cellStore.set("b", existingB);

    const handle = createMockHandle(
      {
        inserted: {
          type: "code",
          source: "new source",
          outputs: [],
          execution_count: "null",
          metadata: { trusted: true },
        },
      },
      ["a", "inserted", "b"],
    );
    const deps = createDeps(handle);

    await materializeChangeset(
      {
        changed: [],
        added: ["inserted"],
        removed: [],
        order_changed: true,
      },
      deps,
    );

    expect(deps.materializeCells).not.toHaveBeenCalled();
    expect(structureProjectionCalls).toHaveLength(1);
    expect(structureProjectionCalls[0]).toMatchObject({
      orderedCellIds: ["a", "inserted", "b"],
      upsertedCells: [
        {
          id: "inserted",
          cell_type: "code",
          source: "new source",
          metadata: { trusted: true },
        },
      ],
    });
    expect(handle.get_cell_type).toHaveBeenCalledTimes(1);
    expect(handle.get_cell_type).toHaveBeenCalledWith("inserted");
    expect(updateCalls).toHaveLength(0);
    expect(cellStore.get("a")).toBe(existingA);
    expect(cellStore.get("b")).toBe(existingB);
    expect(cellStore.get("inserted")).toMatchObject({
      id: "inserted",
      source: "new source",
    });
  });

  it("can publish a leading structural slice before the final projection", async () => {
    const handle = createMockHandle(
      {
        c1: { source: "one" },
        c2: { source: "two" },
        c3: { source: "three" },
        c4: { source: "four" },
        c5: { source: "five" },
      },
      ["c1", "c2", "c3", "c4", "c5"],
    );
    const deps = {
      ...createDeps(handle),
      progressiveStructuralBatchSize: 3,
    };

    await materializeChangeset(
      {
        changed: [],
        added: ["c3", "c1", "c5", "c2", "c4"],
        removed: [],
        order_changed: true,
      },
      deps,
    );

    expect(deps.materializeCells).not.toHaveBeenCalled();
    expect(structureProjectionCalls).toHaveLength(2);
    expect(structureProjectionCalls[0]).toMatchObject({
      orderedCellIds: ["c1", "c2", "c3"],
      upsertedCells: [
        { id: "c1", source: "one" },
        { id: "c2", source: "two" },
        { id: "c3", source: "three" },
      ],
    });
    expect(structureProjectionCalls[1]).toMatchObject({
      orderedCellIds: ["c1", "c2", "c3", "c4", "c5"],
      upsertedCells: [
        { id: "c1", source: "one" },
        { id: "c2", source: "two" },
        { id: "c3", source: "three" },
        { id: "c4", source: "four" },
        { id: "c5", source: "five" },
      ],
    });
  });

  it("does not shrink an already-populated initial streaming projection", async () => {
    cellStore.set("c1", { id: "c1", source: "one" });
    cellStore.set("c2", { id: "c2", source: "two" });
    cellStore.set("c3", { id: "c3", source: "three" });

    const handle = createMockHandle(
      {
        c1: { source: "one" },
        c2: { source: "two" },
        c3: { source: "three" },
        c4: { source: "four" },
        c5: { source: "five" },
      },
      ["c1", "c2", "c3", "c4", "c5"],
    );
    const deps = {
      ...createDeps(handle),
      progressiveStructuralBatchSize: 3,
    };

    await materializeChangeset(
      {
        changed: [],
        added: ["c4", "c5"],
        removed: [],
        order_changed: true,
      },
      deps,
    );

    expect(structureProjectionCalls).toHaveLength(1);
    expect(structureProjectionCalls[0]).toMatchObject({
      orderedCellIds: ["c1", "c2", "c3", "c4", "c5"],
    });
  });

  it("publishes an initial structural slice before full materialization", async () => {
    const handle = createMockHandle(
      {
        c1: { source: "one" },
        c2: { source: "two" },
        c3: { source: "three" },
        c4: { source: "four" },
      },
      ["c1", "c2", "c3", "c4"],
    );

    const published = await publishProgressiveInitialStructureSlice(handle, {
      outputCache: new Map(),
      progressiveStructuralBatchSize: 3,
    });

    expect(published).toBe(true);
    expect(structureProjectionCalls).toHaveLength(1);
    expect(structureProjectionCalls[0]).toMatchObject({
      orderedCellIds: ["c1", "c2", "c3"],
      upsertedCells: [
        { id: "c1", source: "one" },
        { id: "c2", source: "two" },
        { id: "c3", source: "three" },
      ],
    });
  });

  it("projects a pure remove without rematerializing surviving cells", async () => {
    const existingA = {
      id: "a",
      cell_type: "code",
      source: "keep-a",
      outputs: [],
      execution_count: null,
      metadata: {},
    };
    const removed = {
      id: "removed",
      cell_type: "code",
      source: "delete me",
      outputs: [],
      execution_count: null,
      metadata: {},
    };
    const existingB = {
      id: "b",
      cell_type: "code",
      source: "keep-b",
      outputs: [],
      execution_count: null,
      metadata: {},
    };
    cellStore.set("a", existingA);
    cellStore.set("removed", removed);
    cellStore.set("b", existingB);

    const handle = createMockHandle({}, ["a", "b"]);
    const deps = createDeps(handle);

    await materializeChangeset(
      {
        changed: [],
        added: [],
        removed: ["removed"],
        order_changed: true,
      },
      deps,
    );

    expect(deps.materializeCells).not.toHaveBeenCalled();
    expect(structureProjectionCalls).toEqual([
      { orderedCellIds: ["a", "b"], upsertedCells: [] },
    ]);
    expect(handle.get_cell_type).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
    expect(cellStore.get("a")).toBe(existingA);
    expect(cellStore.get("b")).toBe(existingB);
    expect(cellStore.has("removed")).toBe(false);
  });

  it("projects order_changed-only moves through the ordered ID list", async () => {
    const existingA = {
      id: "a",
      cell_type: "code",
      source: "a",
      outputs: [],
      execution_count: null,
      metadata: {},
    };
    const existingB = {
      id: "b",
      cell_type: "code",
      source: "b",
      outputs: [],
      execution_count: null,
      metadata: {},
    };
    cellStore.set("a", existingA);
    cellStore.set("b", existingB);

    const handle = createMockHandle({}, ["b", "a"]);
    const deps = createDeps(handle);

    await materializeChangeset(
      {
        changed: [],
        added: [],
        removed: [],
        order_changed: true,
      },
      deps,
    );

    expect(deps.materializeCells).not.toHaveBeenCalled();
    expect(structureProjectionCalls).toEqual([
      { orderedCellIds: ["b", "a"], upsertedCells: [] },
    ]);
    expect(handle.get_cell_type).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
    expect(cellStore.get("a")).toBe(existingA);
    expect(cellStore.get("b")).toBe(existingB);
  });

  it("materializes final ordered IDs missing from the store even when omitted from added", async () => {
    const existingA = {
      id: "a",
      cell_type: "code",
      source: "keep-a",
      outputs: [],
      execution_count: null,
      metadata: {},
    };
    const existingB = {
      id: "b",
      cell_type: "code",
      source: "keep-b",
      outputs: [],
      execution_count: null,
      metadata: {},
    };
    cellStore.set("a", existingA);
    cellStore.set("b", existingB);

    const handle = createMockHandle(
      {
        late: {
          type: "markdown",
          source: "late materialized",
          metadata: { collapsed: false },
        },
      },
      ["a", "late", "b"],
    );
    const deps = createDeps(handle);

    await materializeChangeset(
      {
        changed: [],
        added: [],
        removed: [],
        order_changed: true,
      },
      deps,
    );

    expect(deps.materializeCells).not.toHaveBeenCalled();
    expect(structureProjectionCalls).toHaveLength(1);
    expect(structureProjectionCalls[0]).toMatchObject({
      orderedCellIds: ["a", "late", "b"],
      upsertedCells: [
        {
          id: "late",
          cell_type: "markdown",
          source: "late materialized",
          metadata: { collapsed: false },
        },
      ],
    });
    expect(handle.get_cell_type).toHaveBeenCalledTimes(1);
    expect(handle.get_cell_type).toHaveBeenCalledWith("late");
    expect(cellStore.get("a")).toBe(existingA);
    expect(cellStore.get("b")).toBe(existingB);
    expect(cellStore.get("late")).toMatchObject({
      id: "late",
      source: "late materialized",
    });
  });

  it("falls back to full materialization when a missing ordered ID cannot be read", async () => {
    const existing = {
      id: "a",
      cell_type: "code",
      source: "keep",
      outputs: [],
      execution_count: null,
      metadata: {},
    };
    cellStore.set("a", existing);

    const handle = createMockHandle({}, ["a", "missing"]);
    const deps = createDeps(handle);

    await materializeChangeset(
      {
        changed: [],
        added: [],
        removed: [],
        order_changed: true,
      },
      deps,
    );

    expect(deps.materializeCells).toHaveBeenCalledWith(handle);
    expect(structureProjectionCalls).toHaveLength(0);
  });

  it("skips materializing an add-then-remove ID absent from the final handle order", async () => {
    const existing = {
      id: "a",
      cell_type: "code",
      source: "keep",
      outputs: [],
      execution_count: null,
      metadata: {},
    };
    cellStore.set("a", existing);

    const handle = createMockHandle({}, ["a"]);
    const deps = createDeps(handle);

    await materializeChangeset(
      {
        changed: [],
        added: ["transient"],
        removed: ["transient"],
        order_changed: true,
      },
      deps,
    );

    expect(deps.materializeCells).not.toHaveBeenCalled();
    expect(structureProjectionCalls).toEqual([
      { orderedCellIds: ["a"], upsertedCells: [] },
    ]);
    expect(handle.get_cell_type).not.toHaveBeenCalledWith("transient");
    expect(updateCalls).toHaveLength(0);
    expect(cellStore.get("a")).toBe(existing);
    expect(cellStore.has("transient")).toBe(false);
  });

  it("falls back to full materialization when a final added cell cannot be read", async () => {
    const handle = createMockHandle({}, ["missing"]);
    const deps = createDeps(handle);

    await materializeChangeset(
      {
        changed: [],
        added: ["missing"],
        removed: [],
        order_changed: true,
      },
      deps,
    );

    expect(deps.materializeCells).toHaveBeenCalledWith(handle);
    expect(structureProjectionCalls).toHaveLength(0);
  });

  it("falls back to full materialization when structural order is unavailable", async () => {
    const handle = {
      get_cell_type: vi.fn(),
      get_cell_source: vi.fn(),
      get_cell_outputs: vi.fn(),
      get_cell_execution_count: vi.fn(),
      get_cell_metadata: vi.fn(),
    } as unknown as import("../../wasm/runtimed-wasm/runtimed_wasm.js").NotebookHandle;
    const deps = createDeps(handle);

    await materializeChangeset(
      {
        changed: [],
        added: ["new-cell"],
        removed: [],
        order_changed: true,
      },
      deps,
    );

    expect(deps.materializeCells).toHaveBeenCalledWith(handle);
    expect(structureProjectionCalls).toHaveLength(0);
  });

  it("falls back to full materialization for resolved_assets changes", async () => {
    const handle = createMockHandle({});
    const deps = createDeps(handle);

    await materializeChangeset(
      {
        changed: [{ cell_id: "c1", fields: { resolved_assets: true } }],
        added: [],
        removed: [],
        order_changed: false,
      },
      deps,
    );

    expect(deps.materializeCells).toHaveBeenCalledWith(handle);
  });

  it("updates cell store chrome fields without rebuilding outputs", async () => {
    // After Phase C-lite, the frame pipeline's incremental path no longer
    // resolves uncached manifest objects — that work belongs to the
    // per-output store (see `applyOutputChangeset`). When a chrome field
    // (here: `source`) changes alongside `outputs`, the cell store is
    // still updated with the new source, but outputs are carried forward
    // from whatever `materializeCellFromWasm` returns (cache-only).
    const manifest = {
      output_type: "execute_result",
      data: { "text/plain": "42" },
      metadata: {},
      execution_count: 1,
    };
    const cache = new Map<string, JupyterOutput>();

    const handle = createMockHandle({
      c1: {
        outputs: [manifest],
        execution_count: "1",
        source: "6 * 7",
      },
    });
    const deps = createDeps(handle, cache);

    await materializeChangeset(
      {
        changed: [{ cell_id: "c1", fields: { outputs: true, source: true } }],
        added: [],
        removed: [],
        order_changed: false,
      },
      deps,
    );

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].cell.source).toBe("6 * 7");
  });

  it("skips cell-store update for output-only changes", async () => {
    // Phase C-lite: when only `fields.outputs` is set, the outputs store
    // already has the new data via the projection pipeline. The frame
    // pipeline no longer writes the resolved outputs into the cell store
    // because <OutputArea> reads from `useCellOutputs` now.
    const cache = new Map<string, JupyterOutput>();
    const handle = createMockHandle({
      c1: { outputs: [], execution_count: "null" },
    });
    const deps = createDeps(handle, cache);

    await materializeChangeset(
      {
        changed: [{ cell_id: "c1", fields: { outputs: true } }],
        added: [],
        removed: [],
        order_changed: false,
      },
      deps,
    );

    expect(updateCalls).toHaveLength(0);
  });

  it("returns early when handle is null", async () => {
    const deps: MaterializeDeps = {
      getHandle: () => null,
      materializeCells: vi.fn(),
      outputCache: new Map(),
    };

    await materializeChangeset(
      {
        changed: [{ cell_id: "c1", fields: { outputs: true } }],
        added: [],
        removed: [],
        order_changed: false,
      },
      deps,
    );

    expect(updateCalls).toHaveLength(0);
    expect(deps.materializeCells).not.toHaveBeenCalled();
  });
});
