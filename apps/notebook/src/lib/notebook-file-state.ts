import type { DisplacedEdits, FileCheckpointState, FileSourceIssue } from "runtimed";

export interface NotebookCausalHeadsReader {
  has_changes_not_contained_by_heads(heads: string[]): boolean | undefined;
}

export interface NotebookDirtyStateInput {
  /** `true` for an untitled local room; `null` while room kind is unknown. */
  ephemeral: boolean | null;
  /** Whether this room is backed by a local notebook file. */
  fileBacked: boolean;
  fileCheckpoint: FileCheckpointState;
  handle: NotebookCausalHeadsReader | null;
}

/**
 * Project titlebar dirty state from causal NotebookDoc/file-checkpoint facts.
 *
 * Untitled notebooks remain dirty. A file-backed notebook is dirty only when
 * its live local document has a change outside the exported checkpoint's
 * causal history. An unavailable handle or checkpoint heads that have not yet
 * reached this peer stay clean until the comparison becomes knowable, avoiding
 * a false dirty flash during bootstrap.
 */
export function notebookDocumentIsDirty({
  ephemeral,
  fileBacked,
  fileCheckpoint,
  handle,
}: NotebookDirtyStateInput): boolean {
  if (ephemeral === true) return true;
  if (!fileBacked || handle === null) return false;

  const exportedHeads = fileCheckpoint.save_sequence === null ? [] : fileCheckpoint.exported_heads;
  try {
    return handle.has_changes_not_contained_by_heads([...exportedHeads]) ?? false;
  } catch {
    // A malformed checkpoint cannot prove that local work is durable. Fail
    // closed in the title while the source issue projection catches up.
    return true;
  }
}

export interface FileSourceIssueNotice {
  title: string;
  message: string;
}

export interface DisplacedEditsNotice {
  title: string;
  message: string;
  snapshotPaths: string[];
  /** Entry ids this notice shows; dismiss exactly these. */
  ids: string[];
}

/**
 * Notice copy for in-session edits that a rewrite of the file on disk
 * replaced. Stays until dismissed; later rewrites never clear it.
 */
export function displacedEditsNotice(
  entries: DisplacedEdits[] | undefined,
): DisplacedEditsNotice | null {
  if (!entries || entries.length === 0) return null;
  const snapshotPaths = entries.map((entry) => entry.snapshot_path).filter((path) => path !== "");
  const times = entries.length === 1 ? "" : ` (${entries.length} times)`;
  const cellIds = [...new Set(entries.flatMap((entry) => entry.cell_ids))];
  const replaced = [
    cellIds.length === 0 ? null : `${cellIds.length === 1 ? "cell" : "cells"} ${cellIds.join(", ")}`,
    entries.some((entry) => entry.metadata) ? "notebook metadata" : null,
  ].filter((part) => part !== null);
  const what = replaced.length === 0 ? "" : ` Replaced: ${replaced.join("; ")}.`;
  const where =
    snapshotPaths.length === 0
      ? "The previous version could not be saved; see the daemon log."
      : snapshotPaths.length === 1
        ? `The previous version is saved at ${snapshotPaths[0]}.`
        : `Previous versions are saved at ${snapshotPaths.join(", ")}.`;
  return {
    title: "The file changed on disk and replaced unsaved edits",
    message: `The notebook now matches the file${times}.${what} ${where}`,
    snapshotPaths,
    ids: entries.map((entry) => entry.id),
  };
}

/** Calm, durable-state-derived notice copy for source recovery problems. */
export function fileSourceIssueNotice(
  issue: FileSourceIssue | null,
): FileSourceIssueNotice | null {
  if (issue === null) return null;
  switch (issue.kind) {
    case "conflict":
      return {
        title: "Notebook file needs reconciliation",
        message: `The live notebook and file on disk are both being preserved. ${issue.reason}`,
      };
    case "degraded":
      return {
        title: "Notebook recovery needs attention",
        message: `The notebook remains open, but durable recovery is not confirmed. ${issue.reason}`,
      };
  }
}
