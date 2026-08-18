import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListTree } from "lucide-react";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { Rail } from "@/components/rail";
import { NotebookDocumentShell } from "../NotebookDocumentShell";
import type { NotebookShellCapabilities } from "../capabilities";

describe("NotebookDocumentShell", () => {
  it("renders rail, toolbar, notices, and notebook content in shared shell slots", () => {
    render(
      <NotebookDocumentShell
        rail={<nav aria-label="Rail">rail</nav>}
        toolbar={<button type="button">Run</button>}
        notices={<p>Syncing</p>}
        toolbarLabel="Notebook fixture toolbar"
        stageLabel="Hosted notebook"
      >
        <section aria-label="Notebook cells">cells</section>
      </NotebookDocumentShell>,
    );

    expect(screen.getByLabelText("Rail")).toBeVisible();
    expect(screen.getByRole("button", { name: "Run" })).toBeVisible();
    expect(screen.getByText("Syncing")).toBeVisible();
    expect(screen.getByLabelText("Notebook fixture toolbar")).toHaveAttribute(
      "data-slot",
      "notebook-document-toolbar",
    );
    expect(screen.getByText("Syncing").parentElement).toHaveAttribute(
      "data-slot",
      "notebook-document-notices",
    );
    expect(screen.getByLabelText("Rail").parentElement).toHaveAttribute(
      "data-slot",
      "notebook-document-body",
    );
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

  it("keeps stage-content controls and notebook content on the panel-aware column", () => {
    const { container } = render(
      <NotebookDocumentShell
        railPanelPlacement="stage"
        toolbar={<button type="button">Run</button>}
        toolbarPlacement="stage-content"
        stageToolbar={<button type="button">Restart</button>}
        stageToolbarPlacement="stage-content"
        rail={
          <Rail
            activePanelId="outline"
            collapsed={false}
            items={[{ id: "outline", label: "Outline", icon: ListTree }]}
            onActivePanelChange={vi.fn()}
            onCollapsedChange={vi.fn()}
          >
            <div data-testid="outline-content">Outline content</div>
          </Rail>
        }
      >
        <section aria-label="Notebook cells">cells</section>
      </NotebookDocumentShell>,
    );

    const stageBody = container.querySelector('[data-slot="notebook-document-stage-body"]');
    const contentToolbar = container.querySelector(
      '[data-slot="notebook-document-stage-content-toolbar"]',
    );
    const panelHost = container.querySelector('[data-slot="notebook-document-rail-panel-host"]');
    const stageContent = container.querySelector('[data-slot="notebook-document-stage-content"]');

    expect(stageBody).toHaveClass(
      "grid-cols-[auto_minmax(0,1fr)]",
      "grid-rows-[auto_minmax(0,1fr)]",
    );
    expect(contentToolbar).toHaveClass("col-start-2", "row-start-1");
    expect(contentToolbar).toContainElement(screen.getByRole("button", { name: "Run" }));
    expect(contentToolbar).toContainElement(screen.getByRole("button", { name: "Restart" }));
    expect(panelHost).toHaveClass("col-start-1", "row-start-2");
    expect(panelHost).toContainElement(screen.getByTestId("outline-content"));
    expect(stageContent).toHaveClass("col-start-2", "row-start-2");
    expect(stageContent).toContainElement(screen.getByLabelText("Notebook cells"));
  });

  it("keeps an expanded panel mounted while its portal placement changes", async () => {
    const user = userEvent.setup();
    const { container } = render(<StageHostedRailHarness />);

    const panelHost = () =>
      container.querySelector('[data-slot="notebook-document-rail-panel-host"]');
    const rail = () => screen.getByTestId("rail");

    expect(panelHost()).not.toContainElement(screen.queryByTestId("outline-content"));

    await user.click(screen.getByRole("button", { name: "Expand panel" }));
    expect(panelHost()).toContainElement(screen.getByTestId("outline-content"));

    await user.click(screen.getByRole("button", { name: "Place panel in rail" }));
    expect(panelHost()).toBeNull();
    expect(rail()).toContainElement(screen.getByTestId("outline-content"));

    await user.click(screen.getByRole("button", { name: "Place panel in stage" }));
    expect(panelHost()).toContainElement(screen.getByTestId("outline-content"));
  });

  it("exposes host capabilities for adapters and smoke tests", () => {
    const capabilities: NotebookShellCapabilities = {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: true,
      canEditStructure: true,
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
      runtime: {
        canWriteRuntimeState: false,
        connected: false,
        source: "cloud",
        actorLabel: null,
        identityLabel: null,
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
    expect(shell).toHaveAttribute("data-can-edit-structure", "true");
    expect(shell).toHaveAttribute("data-can-execute", "false");
    expect(shell).toHaveAttribute("data-can-share", "true");
    expect(shell).toHaveAttribute("data-runtime-connected", "false");
    expect(shell).toHaveAttribute("data-can-write-runtime-state", "false");
  });
});

function StageHostedRailHarness() {
  const [collapsed, setCollapsed] = useState(true);
  const [placement, setPlacement] = useState<"rail" | "stage">("stage");

  return (
    <>
      <button type="button" onClick={() => setCollapsed(false)}>
        Expand panel
      </button>
      <button type="button" onClick={() => setPlacement("rail")}>
        Place panel in rail
      </button>
      <button type="button" onClick={() => setPlacement("stage")}>
        Place panel in stage
      </button>
      <NotebookDocumentShell
        railPanelPlacement={placement}
        rail={
          <Rail
            activePanelId="outline"
            collapsed={collapsed}
            items={[{ id: "outline", label: "Outline", icon: ListTree }]}
            onActivePanelChange={vi.fn()}
            onCollapsedChange={setCollapsed}
          >
            <div data-testid="outline-content">Outline content</div>
          </Rail>
        }
      >
        <section aria-label="Notebook cells">cells</section>
      </NotebookDocumentShell>
    </>
  );
}
