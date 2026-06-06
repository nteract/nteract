import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  NotebookDocumentToolbar,
  shouldShowNotebookDocumentCommandToolbar,
} from "../NotebookDocumentToolbar";
import type { NotebookShellCapabilities } from "../capabilities";

function capabilities(
  overrides: Partial<NotebookShellCapabilities> = {},
): NotebookShellCapabilities {
  return {
    canRead: true,
    canEditMarkdown: false,
    canEditCells: false,
    canEditStructure: false,
    canRequestEdit: false,
    canExecute: false,
    canToggleCode: false,
    canViewPackages: true,
    canManagePackages: false,
    canManageSharing: false,
    access: {
      level: "viewer",
      source: "cloud",
      isPublic: true,
      actorLabel: "anonymous",
      identityLabel: null,
    },
    auth: {
      canSignIn: true,
      canUseAuthenticatedIdentity: false,
      needsAttention: false,
    },
    runtime: {
      canWriteRuntimeState: false,
      connected: false,
      source: "cloud",
      actorLabel: null,
      identityLabel: null,
    },
    ...overrides,
  };
}

describe("NotebookDocumentToolbar", () => {
  it("renders header slots inside the shared toolbar frame", () => {
    const { container } = render(
      <NotebookDocumentToolbar
        capabilities={capabilities()}
        frameClassName="test-frame"
        headerClassName="test-header"
        presence={<span>2 here now, editing</span>}
        utilityControls={<button type="button">Status</button>}
        notices={<p>Syncing</p>}
      />,
    );

    expect(container.querySelector("[data-slot='notebook-toolbar-frame']")).toHaveClass(
      "test-frame",
    );
    expect(container.querySelector("[data-slot='notebook-document-header']")).toHaveClass(
      "test-header",
    );
    expect(screen.getByText("2 here now, editing")).toBeVisible();
    expect(screen.getByRole("button", { name: "Status" })).toBeVisible();
    expect(screen.getByText("Syncing")).toBeVisible();
  });

  it("owns shared command-toolbar visibility policy", () => {
    expect(shouldShowNotebookDocumentCommandToolbar(capabilities())).toBe(false);
    expect(
      shouldShowNotebookDocumentCommandToolbar(
        capabilities({
          canEditStructure: true,
        }),
      ),
    ).toBe(true);
    expect(shouldShowNotebookDocumentCommandToolbar(capabilities(), { reserve: true })).toBe(true);
  });

  it("renders command controls when capabilities or reserved pending state require them", () => {
    const onAddCell = vi.fn();
    const { rerender } = render(
      <NotebookDocumentToolbar
        capabilities={capabilities()}
        commandToolbar={{
          addAfterCellId: "cell-1",
          onAddCell,
        }}
      />,
    );

    expect(screen.queryByTestId("add-code-cell-button")).toBeNull();

    rerender(
      <NotebookDocumentToolbar
        capabilities={capabilities()}
        reserveCommandToolbar
        commandToolbar={{
          addCellControlsDisabled: true,
          addAfterCellId: "cell-1",
          onAddCell,
        }}
      />,
    );

    expect(screen.getByTestId("add-code-cell-button")).toBeDisabled();

    rerender(
      <NotebookDocumentToolbar
        capabilities={capabilities({
          canEditStructure: true,
        })}
        commandToolbar={{
          addAfterCellId: "cell-1",
          onAddCell,
        }}
      />,
    );

    expect(screen.getByTestId("add-code-cell-button")).toBeVisible();
  });
});
