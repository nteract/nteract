import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ErrorBoundary } from "@/lib/error-boundary";
import { NotebookRouteLoader } from "../notebook-route-loader";
import { loadNotebookRouteModule } from "../notebook-route-preload";
import type { ViewerRuntime } from "../cloud-viewer-types";

vi.mock("../notebook-route-preload", () => ({ loadNotebookRouteModule: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const runtime = { config: { notebookId: "startup-fixture" } } as ViewerRuntime;
const authConfig = { oidc: null, localDev: null };

describe("notebook route startup", () => {
  it("mounts a downloaded route without waiting for a fallback timer", async () => {
    vi.useFakeTimers();
    let resolve!: (module: Awaited<ReturnType<typeof loadNotebookRouteModule>>) => void;
    vi.mocked(loadNotebookRouteModule).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<NotebookRouteLoader runtime={runtime} authConfig={authConfig} />);
    expect(screen.getByRole("status").textContent).toBe("Opening notebook");
    await act(async () => {
      resolve({ NotebookRoute: () => <div>Notebook route mounted</div> });
    });
    // No clock advance: a completed download should be usable in this commit.
    expect(screen.getByText("Notebook route mounted")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("passes evaluation failures to the existing error boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loadNotebookRouteModule).mockRejectedValue(new Error("route evaluation failed"));
    await act(async () => {
      render(
        <ErrorBoundary fallback={(error) => <div role="alert">{error.message}</div>}>
          <NotebookRouteLoader runtime={runtime} authConfig={authConfig} />
        </ErrorBoundary>,
      );
    });
    expect(screen.getByRole("alert").textContent).toBe("route evaluation failed");
  });
});
