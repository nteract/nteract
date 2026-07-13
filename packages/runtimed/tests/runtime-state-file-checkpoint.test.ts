import {
  DEFAULT_RUNTIME_STATE,
  type FileCheckpointState,
  type FileSourceIssue,
  type RuntimeState,
} from "runtimed";
import { describe, expect, it } from "vite-plus/test";

function issueLabel(issue: FileSourceIssue | null): string | null {
  if (issue === null) return null;
  switch (issue.kind) {
    case "conflict":
      return `conflict: ${issue.reason}`;
    case "degraded":
      return `degraded: ${issue.reason}`;
  }
}

describe("RuntimeState file checkpoint", () => {
  it("defaults to no checkpoint and no source issue", () => {
    expect(DEFAULT_RUNTIME_STATE.file_checkpoint).toEqual({
      exported_heads: [],
      save_sequence: null,
      source_issue: null,
    });
  });

  it("carries exact exported heads, sequence, and tagged source issues", () => {
    const checkpoint: FileCheckpointState = {
      exported_heads: ["aa11", "bb22"],
      save_sequence: 17,
      source_issue: {
        kind: "conflict",
        reason: "disk and recovery journal diverged",
      },
    };
    const state: RuntimeState = {
      ...DEFAULT_RUNTIME_STATE,
      file_checkpoint: checkpoint,
    };

    expect(state.file_checkpoint).toEqual(checkpoint);
    expect(issueLabel(state.file_checkpoint.source_issue)).toBe(
      "conflict: disk and recovery journal diverged",
    );
    expect(issueLabel({ kind: "degraded", reason: "journal flush failed" })).toBe(
      "degraded: journal flush failed",
    );
  });
});
