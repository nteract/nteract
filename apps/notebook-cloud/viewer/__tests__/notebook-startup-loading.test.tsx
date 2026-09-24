import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import { projectCloudNotebookViewSurface } from "../notebook-view-loading";
import { useNotebookStartupLoading, ViewerStartupLoading } from "../viewer-startup-loading";

afterEach(cleanup);

function EmptyNotebook({ phase }: { phase: "opening" | "ready" | "reconnecting" | "resync" }) {
  const surface = projectCloudNotebookViewSurface({
    bodyAccessBlocked: false,
    cellCount: 0,
    canEditStructure: true,
    connectionError: phase === "reconnecting" ? "cloud sync socket closed" : null,
    editAccessPending: false,
    emptyRoomGraceElapsed: true,
    hasAccessDiagnostic: false,
    hasReadableSnapshot: false,
    liveMaterialized: phase !== "opening",
    status:
      phase === "resync"
        ? { kind: "loading", reason: "sync-recovery", message: "Resynchronizing" }
        : { kind: "ready", message: "Ready" },
  });
  if (useNotebookStartupLoading(surface.shouldShowStartupShell)) {
    return <ViewerStartupLoading title="Empty notebook" />;
  }
  return <input aria-label="Invite collaborator" defaultValue="" />;
}

it("preserves the mounted empty-notebook UI across reconnect and resync", () => {
  const view = render(<EmptyNotebook phase="opening" />);
  expect(screen.getByRole("status").textContent).toBe("Opening notebook");
  view.rerender(<EmptyNotebook phase="ready" />);
  const invite = screen.getByRole("textbox") as HTMLInputElement;
  fireEvent.change(invite, { target: { value: "draft@example.test" } });
  for (const phase of ["reconnecting", "resync"] as const) {
    view.rerender(<EmptyNotebook phase={phase} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("textbox")).toBe(invite);
    expect(invite.value).toBe("draft@example.test");
  }
  view.unmount();
  render(<EmptyNotebook phase="opening" />);
  expect(screen.getByRole("status").textContent).toBe("Opening notebook");
});
