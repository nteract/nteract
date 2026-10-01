import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { NotebookCommandToolbar } from "@/components/notebook/NotebookCommandToolbar";
import { resolveCommentsUiSurface } from "@/components/notebook/comments-ui-gate";
import { notebookUiPolicy } from "../notebook-ui-policy";

describe("notebookUiPolicy", () => {
  it.each(["electron", "tauri", "browser"])("controls pane entry points for %s", (hostName) => {
    const policy = notebookUiPolicy(hostName);
    const enabled = hostName !== "electron";
    const onTogglePackages = vi.fn();
    const onCreateSourceComment = vi.fn();
    const onCreateOutputComment = vi.fn();
    const onActivateCommentThread = vi.fn();
    const surface = resolveCommentsUiSurface({
      commentsEnabled: policy.commentsEnabled,
      canCreateComments: true,
      commentsPanel: "comments panel",
      onCreateSourceComment,
      onCreateOutputComment,
      onActivateCommentThread,
    });

    expect(surface.commentsPanel).toBe(enabled ? "comments panel" : undefined);
    expect(surface.onCreateSourceComment).toBe(enabled ? onCreateSourceComment : undefined);
    expect(surface.onCreateOutputComment).toBe(enabled ? onCreateOutputComment : undefined);
    expect(surface.onActivateCommentThread).toBe(enabled ? onActivateCommentThread : undefined);

    render(
      <NotebookCommandToolbar
        capabilities={{
          canEditStructure: true,
          canExecute: true,
          canViewPackages: true,
          canManageSharing: false,
          canRequestEdit: false,
          auth: { canSignIn: false, canUseAuthenticatedIdentity: false, needsAttention: false },
        }}
        runtime="python"
        environmentManager="conda"
        runtimeStatus={{ state: "idle", label: "Idle", ariaLabel: "Kernel: idle" }}
        onTogglePackages={policy.packageToggleEnabled ? onTogglePackages : undefined}
        onRestartRuntime={vi.fn()}
        onRunAllCells={vi.fn()}
      />,
    );

    expect(screen.getByTestId("kernel-status")).toBeInTheDocument();
    expect(screen.getByTestId("restart-kernel-button")).toBeEnabled();
    expect(screen.getByTestId("run-all-button")).toBeEnabled();
    if (enabled) {
      fireEvent.click(screen.getByTestId("deps-toggle"));
      expect(onTogglePackages).toHaveBeenCalledOnce();
    } else {
      expect(screen.queryByTestId("deps-toggle")).not.toBeInTheDocument();
      expect(onTogglePackages).not.toHaveBeenCalled();
    }
  });
});
