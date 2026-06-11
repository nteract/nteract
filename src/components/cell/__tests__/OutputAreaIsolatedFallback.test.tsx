/**
 * Degraded states for the isolated-output branch of OutputArea.
 *
 * A terminal renderer-bundle failure used to render as a silent blank
 * 24px well per output (plus a console error per frame). The isolated
 * branch now gets the same ErrorBoundary + OutputErrorFallback-with-retry
 * treatment the in-DOM branch has: a visible fallback whose Retry calls
 * the shared provider retry() (module-level state — one recovery
 * un-blanks every output at once).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { OutputArea, type JupyterOutput } from "../OutputArea";

let isolatedFrameMountCount = 0;
let frameShouldThrow = false;

interface MockRendererBundleState {
  rendererCode: string | undefined;
  rendererCss: string | undefined;
  isLoading: boolean;
  error: Error | null;
  lastError: Error | null;
  retry: () => void;
}

let mockRendererBundle: MockRendererBundleState;

vi.mock("@/lib/dark-mode", () => ({
  useDarkMode: () => false,
  useColorTheme: () => undefined,
}));

vi.mock("@/components/isolated/iframe-libraries", () => ({
  injectPluginsForMimes: vi.fn(async () => {}),
  needsPlugin: vi.fn(() => false),
}));

vi.mock("@/components/isolated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/isolated")>();
  const React = await import("react");

  function MockIsolatedFrame() {
    React.useEffect(() => {
      isolatedFrameMountCount += 1;
    }, []);
    if (frameShouldThrow) {
      throw new Error("synthetic isolated frame render failure");
    }
    return <div data-testid="isolated-frame" />;
  }

  return {
    ...actual,
    IsolatedFrame: MockIsolatedFrame,
    useIsolatedRenderer: () => mockRendererBundle,
  };
});

function htmlOutput(outputId: string): JupyterOutput {
  return {
    output_type: "display_data",
    output_id: outputId,
    data: { "text/html": "<b>needs isolation</b>" },
    metadata: {},
  } as JupyterOutput;
}

function streamOutput(outputId: string): JupyterOutput {
  return {
    output_type: "stream",
    output_id: outputId,
    name: "stdout",
    text: "plain stream text",
  } as JupyterOutput;
}

describe("OutputArea isolated degraded states", () => {
  beforeEach(() => {
    isolatedFrameMountCount = 0;
    frameShouldThrow = false;
    mockRendererBundle = {
      rendererCode: undefined,
      rendererCss: undefined,
      isLoading: true,
      error: null,
      lastError: null,
      retry: vi.fn(),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mounts the frame normally while the bundle is still loading", () => {
    render(<OutputArea cellId="cell-1" outputs={[htmlOutput("o1")]} isolated />);

    expect(screen.getByTestId("isolated-frame")).toBeTruthy();
    expect(screen.queryByText("Output rendering failed")).toBeNull();
  });

  it("replaces the blank frame with a visible fallback on terminal bundle failure", () => {
    mockRendererBundle.isLoading = false;
    mockRendererBundle.error = new Error("Failed to fetch renderer JS: 404");
    mockRendererBundle.lastError = mockRendererBundle.error;

    render(<OutputArea cellId="cell-1" outputs={[htmlOutput("o1")]} isolated />);

    expect(screen.queryByTestId("isolated-frame")).toBeNull();
    expect(isolatedFrameMountCount).toBe(0);
    expect(screen.getByText("Output rendering failed")).toBeTruthy();
    expect(screen.getByText("Failed to fetch renderer JS: 404")).toBeTruthy();
  });

  it("wires the fallback Retry to the shared provider retry()", () => {
    mockRendererBundle.isLoading = false;
    mockRendererBundle.error = new Error("Failed to fetch renderer JS: 404");
    mockRendererBundle.lastError = mockRendererBundle.error;

    render(<OutputArea cellId="cell-1" outputs={[htmlOutput("o1")]} isolated />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockRendererBundle.retry).toHaveBeenCalledTimes(1);
  });

  it("renders one quiet fallback per output well and emits no per-frame error cascade", () => {
    mockRendererBundle.isLoading = false;
    mockRendererBundle.error = new Error("Failed to fetch renderer JS: 404");
    mockRendererBundle.lastError = mockRendererBundle.error;

    render(
      <>
        <OutputArea cellId="cell-1" outputs={[htmlOutput("o1")]} isolated />
        <OutputArea cellId="cell-2" outputs={[htmlOutput("o2")]} isolated />
        <OutputArea cellId="cell-3" outputs={[htmlOutput("o3")]} isolated />
      </>,
    );

    // Visible degraded wells instead of N silent blanks...
    expect(screen.getAllByText("Output rendering failed")).toHaveLength(3);
    // ...and no frames mounted, so no renderer-bundle-provider-error
    // cascade per iframe (the page-level notice aggregation lives in
    // CloudNotebookNotices, fed by the single shared provider state).
    expect(isolatedFrameMountCount).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
    // OutputArea must NEVER render the page-level notice itself — N
    // failing wells aggregate into ONE notice in the cloud notices stack.
    expect(screen.queryByText("Output renderer unavailable.")).toBeNull();
  });

  it("keeps the fallback mounted through an in-flight retry instead of churning blank frames", () => {
    // The provider reports a retry kicked from a terminal error as
    // isLoading with lastError sticky.
    mockRendererBundle.isLoading = true;
    mockRendererBundle.error = null;
    mockRendererBundle.lastError = new Error("Failed to fetch renderer JS: 404");

    render(<OutputArea cellId="cell-1" outputs={[htmlOutput("o1")]} isolated />);

    expect(screen.queryByTestId("isolated-frame")).toBeNull();
    expect(isolatedFrameMountCount).toBe(0);
    expect(screen.getByText("Output rendering failed")).toBeTruthy();
  });

  it("recovers in place once the shared bundle state clears", () => {
    mockRendererBundle.isLoading = false;
    mockRendererBundle.error = new Error("Failed to fetch renderer JS: 404");
    mockRendererBundle.lastError = mockRendererBundle.error;

    const outputs = [htmlOutput("o1")];
    const { rerender } = render(<OutputArea cellId="cell-1" outputs={outputs} isolated />);
    expect(screen.queryByTestId("isolated-frame")).toBeNull();

    mockRendererBundle = {
      rendererCode: "code",
      rendererCss: "css",
      isLoading: false,
      error: null,
      lastError: null,
      retry: vi.fn(),
    };
    rerender(<OutputArea cellId="cell-1" outputs={outputs} isolated />);

    expect(screen.queryByText("Output rendering failed")).toBeNull();
    expect(screen.getByTestId("isolated-frame")).toBeTruthy();
  });

  it("leaves in-DOM outputs untouched by a renderer bundle failure", () => {
    mockRendererBundle.isLoading = false;
    mockRendererBundle.error = new Error("Failed to fetch renderer JS: 404");
    mockRendererBundle.lastError = mockRendererBundle.error;

    render(<OutputArea cellId="cell-1" outputs={[streamOutput("s1")]} isolated={false} />);

    expect(screen.getByText("plain stream text")).toBeTruthy();
    expect(screen.queryByText("Output rendering failed")).toBeNull();
  });

  it("catches isolated-branch render errors in the new boundary with a retry affordance", () => {
    frameShouldThrow = true;

    render(<OutputArea cellId="cell-1" outputs={[htmlOutput("o1")]} isolated />);

    expect(screen.getByText("Output rendering failed")).toBeTruthy();
    expect(screen.getByText("synthetic isolated frame render failure")).toBeTruthy();

    // Boundary reset: healed frame re-renders cleanly after Retry.
    frameShouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByTestId("isolated-frame")).toBeTruthy();
  });

  it("auto-resets the boundary when a NEW outputs array arrives (resetKeys), no Retry click", () => {
    frameShouldThrow = true;

    const { rerender } = render(
      <OutputArea cellId="cell-1" outputs={[htmlOutput("o1")]} isolated />,
    );
    expect(screen.getByText("Output rendering failed")).toBeTruthy();

    // Re-execution delivers a fresh outputs array: resetKeys=[outputs]
    // must clear the boundary without any user interaction.
    frameShouldThrow = false;
    rerender(<OutputArea cellId="cell-1" outputs={[htmlOutput("o2")]} isolated />);

    expect(screen.queryByText("Output rendering failed")).toBeNull();
    expect(screen.getByTestId("isolated-frame")).toBeTruthy();
  });
});
