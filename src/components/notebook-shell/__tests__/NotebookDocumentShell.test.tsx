import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { NotebookDocumentShell } from "../NotebookDocumentShell";
import type { NotebookShellCapabilities } from "../capabilities";

describe("NotebookDocumentShell", () => {
  it("renders rail, toolbar, notices, and notebook content in shared shell slots", () => {
    render(
      <NotebookDocumentShell
        rail={<nav aria-label="Rail">rail</nav>}
        toolbar={<button type="button">Run</button>}
        notices={<p>Syncing</p>}
        stageLabel="Hosted notebook"
      >
        <section aria-label="Notebook cells">cells</section>
      </NotebookDocumentShell>,
    );

    expect(screen.getByLabelText("Rail")).toBeVisible();
    expect(screen.getByRole("button", { name: "Run" })).toBeVisible();
    expect(screen.getByText("Syncing")).toBeVisible();
    expect(screen.getByLabelText("Hosted notebook")).toHaveAttribute(
      "data-slot",
      "notebook-document-stage",
    );
    expect(screen.getByLabelText("Notebook cells")).toBeVisible();
  });

  it("can render as the document main landmark for hosted notebook routes", () => {
    const { container } = render(
      <NotebookDocumentShell rootElement="main" stageLabel="Hosted notebook">
        <div>content</div>
      </NotebookDocumentShell>,
    );

    expect(container.querySelector("main[data-slot='notebook-document-shell']")).not.toBeNull();
    expect(screen.getByLabelText("Hosted notebook")).toBeVisible();
  });

  it("exposes host capabilities for adapters and smoke tests", () => {
    const capabilities: NotebookShellCapabilities = {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: true,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: true,
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: true,
        needsAttention: false,
      },
    };

    const { container } = render(
      <NotebookDocumentShell capabilities={capabilities}>
        <div>content</div>
      </NotebookDocumentShell>,
    );

    const shell = container.querySelector("[data-slot='notebook-document-shell']");
    expect(shell).toHaveAttribute("data-authenticated", "true");
    expect(shell).toHaveAttribute("data-can-edit", "true");
    expect(shell).toHaveAttribute("data-can-execute", "false");
    expect(shell).toHaveAttribute("data-can-share", "true");
  });
});
