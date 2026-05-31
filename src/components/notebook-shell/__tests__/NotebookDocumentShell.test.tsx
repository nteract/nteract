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

  it("can render a fixed host header above the rail and document stage", () => {
    const { container } = render(
      <NotebookDocumentShell
        header={<button type="button">Sign in</button>}
        headerLabel="Notebook controls"
        rail={<nav aria-label="Rail">rail</nav>}
        stageLabel="Hosted notebook"
      >
        <section aria-label="Notebook cells">cells</section>
      </NotebookDocumentShell>,
    );

    const header = container.querySelector("[data-slot='notebook-document-header-frame']");
    const body = container.querySelector("[data-slot='notebook-document-body']");
    expect(header).not.toBeNull();
    expect(header).toHaveAttribute("aria-label", "Notebook controls");
    expect(body).not.toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(screen.getByLabelText("Rail")).toBeVisible();
    expect(screen.getByLabelText("Hosted notebook")).toBeVisible();
    expect(screen.getByLabelText("Notebook cells")).toBeVisible();
  });

  it("exposes host capabilities for adapters and smoke tests", () => {
    const capabilities: NotebookShellCapabilities = {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: true,
      canRequestEdit: true,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: true,
      access: {
        level: "owner",
        source: "cloud",
        isPublic: false,
        actorLabel: "user:anaconda:alice/browser:tab",
        identityLabel: "alice@example.test",
      },
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
    expect(shell).toHaveAttribute("data-access-level", "owner");
    expect(shell).toHaveAttribute("data-access-source", "cloud");
    expect(shell).toHaveAttribute("data-can-edit", "true");
    expect(shell).toHaveAttribute("data-can-execute", "false");
    expect(shell).toHaveAttribute("data-can-share", "true");
  });
});
