import { describe, expect, it, vi } from "vite-plus/test";
import type { FileCheckpointState } from "runtimed";
import {
  displacedEditsNotice,
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

describe("displacedEditsNotice", () => {
  const entry = (id: string, snapshot_path: string, cell_ids: string[], metadata = false) => ({
    id,
    snapshot_path,
    heads: ["aa"],
    displaced_at: "2026-11-16T00:00:00Z",
    cell_ids,
    metadata,
  });

  it("is absent without entries, including from older daemons", () => {
    expect(displacedEditsNotice(undefined)).toBeNull();
    expect(displacedEditsNotice([])).toBeNull();
  });

  it("names what was replaced, every snapshot path, and the ids it shows", () => {
    expect(displacedEditsNotice([entry("e1", "/s/one.ipynb", ["a"])])).toEqual({
      title: "The file changed on disk and replaced unsaved edits",
      message:
        "The notebook now matches the file. Replaced: cell a. The previous version is saved at /s/one.ipynb.",
      snapshotPaths: ["/s/one.ipynb"],
      ids: ["e1"],
    });
    const two = displacedEditsNotice([
      entry("e1", "/s/one.ipynb", ["a", "b"]),
      entry("e2", "/s/two.ipynb", ["b"], true),
    ]);
    expect(two?.message).toBe(
      "The notebook now matches the file (2 times). Replaced: cells a, b; notebook metadata. Previous versions are saved at /s/one.ipynb, /s/two.ipynb.",
    );
    expect(two?.ids).toEqual(["e1", "e2"]);
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
