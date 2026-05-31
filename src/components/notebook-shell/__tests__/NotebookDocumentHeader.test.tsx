import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vite-plus/test";
import { NotebookDocumentHeader } from "../NotebookDocumentHeader";
import {
  NotebookDocumentHeaderButton,
  NotebookDocumentHeaderMenu,
} from "../NotebookDocumentHeaderControl";
import type { NotebookShellCapabilities } from "../capabilities";

function capabilities(
  overrides: Partial<NotebookShellCapabilities> = {},
): NotebookShellCapabilities {
  return {
    canRead: true,
    canEditMarkdown: false,
    canEditCells: false,
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
    ...overrides,
  };
}

describe("NotebookDocumentHeader", () => {
  it("always renders presence and utility controls", () => {
    render(
      <NotebookDocumentHeader
        capabilities={capabilities()}
        presence={<span>1 viewing</span>}
        utilityControls={<button type="button">Theme</button>}
      />,
    );

    expect(screen.getByText("1 viewing")).toBeVisible();
    expect(screen.getByRole("button", { name: "Theme" })).toBeVisible();
  });

  it("gates document controls through shared shell capabilities", () => {
    render(
      <NotebookDocumentHeader
        capabilities={capabilities()}
        runtimeControls={<button type="button">Run</button>}
        codeControls={<button type="button">Code</button>}
        sharingControls={<button type="button">Share</button>}
        editControls={<button type="button">Edit</button>}
        authControls={<button type="button">Sign in</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "Run" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  it("exposes all controls when the host grants those capabilities", () => {
    const { container } = render(
      <NotebookDocumentHeader
        capabilities={capabilities({
          canEditMarkdown: true,
          canEditCells: true,
          canRequestEdit: true,
          canToggleCode: true,
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
        })}
        runtimeControls={<button type="button">Run</button>}
        codeControls={<button type="button">Code</button>}
        sharingControls={<button type="button">Share</button>}
        editControls={<button type="button">Edit</button>}
        authControls={<button type="button">Identity</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "Run" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Code" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Share" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Identity" })).toBeVisible();
    expect(container.querySelector("[data-slot='notebook-document-header']")).toHaveAttribute(
      "data-can-request-edit",
      "true",
    );
  });

  it("provides shared header button chrome for host controls", () => {
    render(
      <NotebookDocumentHeaderButton active tone="positive" icon={<span aria-hidden="true">i</span>}>
        Edit
      </NotebookDocumentHeaderButton>,
    );

    const button = screen.getByRole("button", { name: "Edit" });
    expect(button).toHaveAttribute("data-active", "true");
    expect(button).toHaveAttribute("data-tone", "positive");
    expect(button.className).toContain("rounded-full");
  });

  it("provides a shared header menu panel for host-specific forms", async () => {
    render(
      <NotebookDocumentHeaderMenu trigger={<span>Identity</span>} triggerTitle="Identity menu">
        <button type="button">Sign out</button>
      </NotebookDocumentHeaderMenu>,
    );

    const user = userEvent.setup();
    const summary = screen.getByTitle("Identity menu");
    await user.click(summary);

    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(
      document.querySelector("[data-slot='notebook-document-header-menu-panel']"),
    ).not.toBeNull();
  });
});
