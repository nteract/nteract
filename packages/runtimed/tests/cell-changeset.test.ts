import {
  classifyCellChangesetMaterialization,
  cellChangesetTouchesChrome,
  type CellChangeset,
  mergeChangesets,
  planCellPointerRefresh,
  planCellChangesetProjection,
  summarizeChangedFields,
} from "runtimed";
import { describe, expect, it } from "vite-plus/test";

const empty: CellChangeset = {
  changed: [],
  added: [],
  removed: [],
  order_changed: false,
};

function outputsOnly(cellId: string): CellChangeset {
  return {
    changed: [{ cell_id: cellId, fields: { outputs: true } }],
    added: [],
    removed: [],
    order_changed: false,
  };
}

describe("CellChangeset helpers", () => {
  it("merges sparse changed fields without mutating inputs", () => {
    const source: CellChangeset = {
      changed: [{ cell_id: "cell-1", fields: { source: true } }],
      added: [],
      removed: [],
      order_changed: false,
    };
    const outputs = outputsOnly("cell-1");
    const originalSourceFields = { ...source.changed[0].fields };

    expect(mergeChangesets(source, outputs)).toEqual({
      changed: [{ cell_id: "cell-1", fields: { source: true, outputs: true } }],
      added: [],
      removed: [],
      order_changed: false,
    });
    expect(source.changed[0].fields).toEqual(originalSourceFields);
  });

  it("classifies missing changesets and resolved assets as full materialization", () => {
    expect(classifyCellChangesetMaterialization(null)).toEqual({
      kind: "full",
      reason: "missing_changeset",
    });
    expect(
      classifyCellChangesetMaterialization({
        ...empty,
        changed: [{ cell_id: "cell-1", fields: { resolved_assets: true } }],
      }),
    ).toEqual({ kind: "full", reason: "resolved_assets" });
  });

  it("classifies cell and structural updates as incremental materialization", () => {
    expect(classifyCellChangesetMaterialization(outputsOnly("cell-1"))).toEqual({
      kind: "incremental",
    });
    expect(
      classifyCellChangesetMaterialization({
        ...empty,
        added: ["cell-new"],
        order_changed: true,
      }),
    ).toEqual({ kind: "incremental" });
    expect(
      classifyCellChangesetMaterialization({
        ...empty,
        removed: ["cell-old"],
        order_changed: true,
      }),
    ).toEqual({ kind: "incremental" });
    expect(
      classifyCellChangesetMaterialization({
        ...empty,
        order_changed: true,
      }),
    ).toEqual({ kind: "incremental" });
  });

  it("plans output-only updates without cell chrome writes", () => {
    expect(planCellChangesetProjection(outputsOnly("cell-1"))).toEqual({
      kind: "incremental",
      cells: [
        {
          cell_id: "cell-1",
          fields: { outputs: true },
          touches_chrome: false,
          touches_outputs: true,
          preserve_source: true,
          field_summary: ["out"],
        },
      ],
    });
  });

  it("plans full projection for missing changesets and resolved assets", () => {
    expect(planCellChangesetProjection(null)).toEqual({
      kind: "full",
      reason: "missing_changeset",
    });
    expect(
      planCellChangesetProjection({
        ...empty,
        changed: [{ cell_id: "cell-1", fields: { resolved_assets: true } }],
      }),
    ).toEqual({ kind: "full", reason: "resolved_assets" });
  });

  it("plans structural changes as incremental projections", () => {
    expect(
      planCellChangesetProjection({
        ...empty,
        added: ["cell-new"],
        removed: ["cell-old"],
        order_changed: true,
      }),
    ).toEqual({
      kind: "incremental",
      structural: {
        added: ["cell-new"],
        removed: ["cell-old"],
        order_changed: true,
      },
      cells: [],
    });
  });

  it("keeps add-then-remove structural details for final-handle projection", () => {
    const merged = mergeChangesets(
      { ...empty, added: ["cell-transient"], order_changed: true },
      { ...empty, removed: ["cell-transient"], order_changed: true },
    );

    expect(planCellChangesetProjection(merged)).toEqual({
      kind: "incremental",
      structural: {
        added: ["cell-transient"],
        removed: ["cell-transient"],
        order_changed: true,
      },
      cells: [],
    });
  });

  it("plans chrome updates and source preservation for app projections", () => {
    expect(
      planCellChangesetProjection({
        ...empty,
        changed: [
          {
            cell_id: "cell-1",
            fields: { outputs: true, execution_count: true },
          },
          {
            cell_id: "cell-2",
            fields: { source: true, metadata: true },
          },
        ],
      }),
    ).toEqual({
      kind: "incremental",
      cells: [
        {
          cell_id: "cell-1",
          fields: { outputs: true, execution_count: true },
          touches_chrome: true,
          touches_outputs: true,
          preserve_source: true,
          field_summary: ["out", "ec"],
        },
        {
          cell_id: "cell-2",
          fields: { source: true, metadata: true },
          touches_chrome: true,
          touches_outputs: false,
          preserve_source: false,
          field_summary: ["src", "meta"],
        },
      ],
    });
  });

  it("exposes field-level projection helpers", () => {
    expect(cellChangesetTouchesChrome({ outputs: true })).toBe(false);
    expect(cellChangesetTouchesChrome({ position: true })).toBe(true);
    expect(
      summarizeChangedFields({
        source: true,
        outputs: true,
        execution_count: true,
        metadata: true,
        position: true,
      }),
    ).toEqual(["src", "out", "ec", "meta"]);
  });

  it("plans pointer refreshes for touched cells only on incremental changes", () => {
    expect(
      planCellPointerRefresh({
        ...empty,
        changed: [
          { cell_id: "cell-1", fields: { outputs: true } },
          { cell_id: "cell-1", fields: { execution_count: true } },
          { cell_id: "cell-2", fields: { source: true } },
        ],
      }),
    ).toEqual({ kind: "touched", cell_ids: ["cell-1", "cell-2"] });
  });

  it("preserves the historic full pointer refresh cases", () => {
    expect(planCellPointerRefresh(null)).toEqual({ kind: "all" });
    expect(planCellPointerRefresh({ ...empty, added: ["cell-new"] })).toEqual({
      kind: "all",
    });
  });

  it("preserves historic no-op pointer refreshes for structural changes without touched cells", () => {
    expect(planCellPointerRefresh({ ...empty, removed: ["cell-old"] })).toEqual({
      kind: "none",
    });
    expect(planCellPointerRefresh({ ...empty, order_changed: true })).toEqual({
      kind: "none",
    });
  });

  it("preserves historic touched pointer refreshes for resolved-assets changes", () => {
    expect(
      planCellPointerRefresh({
        ...empty,
        changed: [{ cell_id: "cell-1", fields: { resolved_assets: true } }],
      }),
    ).toEqual({ kind: "touched", cell_ids: ["cell-1"] });
  });

  it("skips pointer refreshes when an incremental changeset touches no cells", () => {
    expect(planCellPointerRefresh(empty)).toEqual({ kind: "none" });
  });
});
