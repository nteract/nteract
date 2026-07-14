import { describe, expect, it, vi } from "vite-plus/test";
import type { FileCheckpointState } from "runtimed";
import {
  fileSourceIssueNotice,
  notebookDocumentIsDirty,
  type NotebookCausalHeadsReader,
} from "../notebook-file-state";

const NO_CHECKPOINT: FileCheckpointState = {
  exported_heads: [],
  save_sequence: null,
  source_issue: null,
};

function reader(result: boolean | undefined): NotebookCausalHeadsReader {
  return {
    has_changes_not_contained_by_heads: vi.fn(() => result),
  };
}

describe("notebookDocumentIsDirty", () => {
  it("keeps untitled notebooks dirty before a handle exists", () => {
    expect(
      notebookDocumentIsDirty({
        ephemeral: true,
        fileBacked: false,
        fileCheckpoint: NO_CHECKPOINT,
        handle: null,
      }),
    ).toBe(true);
  });

  it("queries the whole causal history when no checkpoint has committed", () => {
    const handle = reader(true);

    expect(
      notebookDocumentIsDirty({
        ephemeral: false,
        fileBacked: true,
        fileCheckpoint: NO_CHECKPOINT,
        handle,
      }),
    ).toBe(true);
    expect(handle.has_changes_not_contained_by_heads).toHaveBeenCalledWith([]);
  });

  it("uses exported checkpoint heads instead of exact head-array equality", () => {
    const handle = reader(false);
    const fileCheckpoint: FileCheckpointState = {
      exported_heads: ["head-a", "head-b"],
      save_sequence: 4,
      source_issue: null,
    };

    expect(
      notebookDocumentIsDirty({ ephemeral: false, fileBacked: true, fileCheckpoint, handle }),
    ).toBe(false);
    expect(handle.has_changes_not_contained_by_heads).toHaveBeenCalledWith([
      "head-a",
      "head-b",
    ]);

    const dirtyHandle = reader(true);
    expect(
      notebookDocumentIsDirty({
        ephemeral: false,
        fileBacked: true,
        fileCheckpoint,
        handle: dirtyHandle,
      }),
    ).toBe(true);
  });

  it("does not apply local file checkpoints to hosted notebooks", () => {
    const handle = reader(true);

    expect(
      notebookDocumentIsDirty({
        ephemeral: false,
        fileBacked: false,
        fileCheckpoint: NO_CHECKPOINT,
        handle,
      }),
    ).toBe(false);
    expect(handle.has_changes_not_contained_by_heads).not.toHaveBeenCalled();
  });

  it("waits for unknown checkpoint heads and fails closed on malformed heads", () => {
    const fileCheckpoint: FileCheckpointState = {
      exported_heads: ["not-here-yet"],
      save_sequence: 2,
      source_issue: null,
    };

    expect(
      notebookDocumentIsDirty({
        ephemeral: false,
        fileBacked: true,
        fileCheckpoint,
        handle: reader(undefined),
      }),
    ).toBe(false);
    expect(
      notebookDocumentIsDirty({
        ephemeral: false,
        fileBacked: true,
        fileCheckpoint,
        handle: {
          has_changes_not_contained_by_heads: () => {
            throw new Error("invalid change hash");
          },
        },
      }),
    ).toBe(true);
  });
});

describe("fileSourceIssueNotice", () => {
  it("projects calm conflict and degraded copy", () => {
    expect(fileSourceIssueNotice(null)).toBeNull();
    expect(
      fileSourceIssueNotice({ kind: "conflict", reason: "Disk fingerprint changed." }),
    ).toEqual({
      title: "Notebook file needs reconciliation",
      message:
        "The live notebook and file on disk are both being preserved. Disk fingerprint changed.",
    });
    expect(
      fileSourceIssueNotice({ kind: "degraded", reason: "Journal flush failed." }),
    ).toEqual({
      title: "Notebook recovery needs attention",
      message:
        "The notebook remains open, but durable recovery is not confirmed. Journal flush failed.",
    });
  });
});
