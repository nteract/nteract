import type { FileCheckpointState, FileSourceIssue } from "runtimed";

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
