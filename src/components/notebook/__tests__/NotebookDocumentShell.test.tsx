import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListTree } from "lucide-react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { Rail, RAIL_TAKEOVER_STAGE_CLASS_NAME } from "@/components/rail";
import { NotebookRail, type NotebookRailPanelId } from "@/components/notebook-rail";
import { NotebookBrandMark } from "../NotebookBrandMark";
import { NotebookDocumentShell } from "../NotebookDocumentShell";
import type { NotebookShellCapabilities } from "../capabilities";

describe("NotebookDocumentShell", () => {
  it.each(["rail", "stage"] as const)(
    "preserves mounted notebook, output, and panel nodes when changing sides (%s)",
    (placement) => {
      const mounted = vi.fn();
      const unmounted = vi.fn();
      function NotebookContent() {
        useEffect(() => {
          mounted();
          return unmounted;
        }, []);
        return (
          <section aria-label="Notebook cells">
            <input aria-label="Cell source" defaultValue="print(1)" />
            <iframe title="Output frame" />
          </section>
        );
      }
      const shell = (railSide: "left" | "right") => (
        <NotebookDocumentShell
          railSide={railSide}
          railPanelPlacement={placement}
          toolbar={<button type="button">Run</button>}
          toolbarPlacement="stage-content"
          toolbarClassName={RAIL_TAKEOVER_STAGE_CLASS_NAME}
          stageContentClassName={RAIL_TAKEOVER_STAGE_CLASS_NAME}
          rail={
            <Rail
              railSide={railSide}
              activePanelId="outline"
              collapsed={false}
              panelTitle="Outline"
              items={[{ id: "outline", label: "Outline", icon: ListTree }]}
              onActivePanelChange={vi.fn()}
              onCollapsedChange={vi.fn()}
            >
              <input aria-label="Panel search" defaultValue="heading" />
            </Rail>
          }
        >
          <NotebookContent />
        </NotebookDocumentShell>
      );
      const { container, rerender } = render(shell("left"));
      const notebook = screen.getByLabelText("Notebook cells");
      const notebookParent = notebook.parentElement;
      const output = screen.getByTitle("Output frame");
      const source = screen.getByRole("textbox", { name: "Cell source" });
      const search = screen.getByRole("textbox", { name: "Panel search" });
      const panelParent = search.closest('[data-slot="rail-panel"]')?.parentElement;
      const runButton = screen.getByRole("button", { name: "Run" });
      const toolbarParent = runButton.parentElement;
      const panelHost = container.querySelector('[data-slot="notebook-document-rail-panel-host"]');

      rerender(shell("right"));

      expect(container.querySelector('[data-slot="notebook-document-body"]')).toHaveClass(
        "flex-row-reverse",
      );
      expect(screen.getByLabelText("Notebook cells")).toBe(notebook);
      expect(notebook.parentElement).toBe(notebookParent);
      expect(screen.getByTitle("Output frame")).toBe(output);
      expect(screen.getByRole("textbox", { name: "Cell source" })).toBe(source);
      expect(screen.getByRole("textbox", { name: "Panel search" })).toBe(search);
      expect(search.closest('[data-slot="rail-panel"]')?.parentElement).toBe(panelParent);
      expect(screen.getByRole("button", { name: "Run" })).toBe(runButton);
      expect(runButton.parentElement).toBe(toolbarParent);
      expect(toolbarParent).toHaveClass(RAIL_TAKEOVER_STAGE_CLASS_NAME);
      expect(mounted).toHaveBeenCalledTimes(1);
      expect(unmounted).not.toHaveBeenCalled();
      if (placement === "stage") {
        expect(container.querySelector('[data-slot="notebook-document-stage-body"]')).toHaveClass(
          "grid-cols-[minmax(0,1fr)_auto]",
        );
        expect(
          container.querySelector('[data-slot="notebook-document-stage-content-toolbar"]'),
        ).toHaveClass("col-start-1", "row-start-1");
        expect(panelHost).toHaveClass("col-start-2", "row-start-1", "row-end-[-1]");
        expect(panelHost).toContainElement(search);
        expect(screen.getByTestId("rail")).not.toContainElement(search);
        expect(notebookParent).toHaveClass(
          "col-start-1",
          "row-start-2",
          RAIL_TAKEOVER_STAGE_CLASS_NAME,
        );
      } else {
        expect(screen.getByTestId("rail")).toContainElement(search);
        expect(panelHost).toBeNull();
      }

      rerender(shell("left"));
      expect(screen.getByLabelText("Notebook cells")).toBe(notebook);
      expect(screen.getByTitle("Output frame")).toBe(output);
      expect(screen.getByRole("textbox", { name: "Panel search" })).toBe(search);
      expect(container.querySelector('[data-slot="notebook-document-body"]')).not.toHaveClass(
        "flex-row-reverse",
      );
      expect(mounted).toHaveBeenCalledTimes(1);
      expect(unmounted).not.toHaveBeenCalled();
    },
  );

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
    expect(panelHost).toHaveClass("col-start-1", "row-start-1", "row-end-[-1]");
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

  it.each([false, true])(
    "keeps branding fixed while panels toggle (hosted: %s)",
    async (hosted) => {
      const user = userEvent.setup();
      const { container } = render(<BrandedShellHarness hosted={hosted} />);
      const brand = screen.getByRole("img", { name: "nteract" });
      const brandSlot = brand.closest(
        hosted ? '[data-slot="notebook-document-toolbar"]' : '[data-slot="rail-leading-slot"]',
      );
      expect(brandSlot).not.toBeNull();

      await user.click(screen.getByRole("button", { name: "Outline" }));
      const panelHost = container.querySelector('[data-slot="notebook-document-rail-panel-host"]');
      expect(panelHost).toContainElement(screen.getByRole("heading", { name: "Outline" }));
      expect(panelHost).toHaveClass("row-start-1", "row-end-[-1]");
      expect(brandSlot).toContainElement(brand);
      expect(panelHost).not.toContainElement(brand);

      await user.click(screen.getByRole("button", { name: "Packages" }));
      expect(panelHost).toContainElement(screen.getByRole("heading", { name: "Packages" }));
      expect(screen.queryByRole("heading", { name: "Outline" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Packages" }));
      expect(screen.queryByRole("heading", { name: "Packages" })).not.toBeInTheDocument();
      expect(brandSlot).toContainElement(brand);
      expect(screen.getAllByRole("img", { name: "nteract" })).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Run" })).toBeVisible();
      if (hosted) expect(screen.getByRole("button", { name: "Share" })).toBeVisible();
    },
  );

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

function BrandedShellHarness({ hosted }: { hosted: boolean }) {
  const [collapsed, setCollapsed] = useState(true);
  const [activePanelId, setActivePanelId] = useState<NotebookRailPanelId>("outline");

  return (
    <NotebookDocumentShell
      railPanelPlacement="stage"
      toolbar={
        hosted ? (
          <>
            <NotebookBrandMark />
            <span>Notebook title</span>
            <button type="button">Share</button>
          </>
        ) : null
      }
      stageToolbar={<button type="button">Run</button>}
      stageToolbarPlacement="stage-content"
      rail={
        <NotebookRail
          activePanelId={activePanelId}
          collapsed={collapsed}
          leadingSlot={hosted ? null : <NotebookBrandMark />}
          outlineItems={[]}
          packagesPanel={<p>Package details</p>}
          onActivePanelChange={setActivePanelId}
          onCollapsedChange={setCollapsed}
        />
      }
    >
      <section aria-label="Notebook cells">cells</section>
    </NotebookDocumentShell>
  );
}

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
