import { NotebookHostProvider } from "@nteract/notebook-host";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CrdtBridgeProvider } from "@/components/notebook/crdt-bridge";
import {
  flushCellUIState,
  setActiveInteractionTarget,
} from "@/components/notebook/state/cell-ui-state";
import { replaceNotebookCells } from "@/components/notebook/state/cell-store";
import { resetNotebookExecutions } from "@/components/notebook/state/execution-store";
import { resetNotebookOutputs } from "@/components/notebook/state/output-store";
import { createFixtureNotebookHost } from "../../../../elements/components/fixture-notebook-host";
import type { NotebookCell } from "../../types";
import { NotebookView, type NotebookViewProps } from "../NotebookView";

vi.mock("@/components/isolated/iframe-libraries", () => ({
  injectPluginsForMimes: vi.fn(async () => {}),
}));
vi.mock("@/components/cell/OutputArea", () => ({ OutputArea: () => null }));

const excludedCode: NotebookCell = {
  id: "code",
  cell_type: "code",
  source: "x = 1",
  execution_count: null,
  outputs: [],
  metadata: { nteract: { context_exclude: true } },
};
const prompt: NotebookCell = {
  id: "prompt",
  cell_type: "raw",
  source: "What is x?",
  metadata: { nteract: { prompt: { mode: "explore" } } },
};

function notebook(cells: NotebookCell[], props: Partial<NotebookViewProps>) {
  return (
    <NotebookHostProvider host={createFixtureNotebookHost()}>
      <CrdtBridgeProvider getHandle={() => null} onSyncNeeded={() => {}} localActor="prompt-test">
        <NotebookView
          cellIds={cells.map((cell) => cell.id)}
          autoFocusFirstCell={false}
          canAcceptCellMutations
          onFocusCell={() => {}}
          onExecuteCell={() => {}}
          onInterruptKernel={() => {}}
          onDeleteCell={() => {}}
          onMoveCell={() => {}}
          onAddCell={() => null}
          {...props}
        />
      </CrdtBridgeProvider>
    </NotebookHostProvider>
  );
}

async function mount(cells: NotebookCell[], props: Partial<NotebookViewProps>) {
  replaceNotebookCells(cells);
  const view = render(notebook(cells, props));
  await act(async () => {});
  return view;
}

function actionOverlay(cellId: string) {
  return document.querySelector(`[data-cell-id="${cellId}"] [data-slot="cell-action-overlay"]`);
}

function pressShiftEnterIn(cellId: string) {
  const content = document.querySelector<HTMLElement>(`[data-cell-id="${cellId}"] .cm-content`);
  expect(content).not.toBeNull();
  fireEvent.keyDown(content!, { key: "Enter", shiftKey: true });
}

const rangeDescriptors = {
  getClientRects: Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects"),
  getBoundingClientRect: Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect"),
};

beforeEach(() => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("CSS", { ...globalThis.CSS, escape: (value: string) => value });
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      matches: false,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  setActiveInteractionTarget(null);
  resetNotebookExecutions();
  resetNotebookOutputs();
  replaceNotebookCells([]);
  flushCellUIState();
  vi.unstubAllGlobals();
  for (const [key, descriptor] of Object.entries(rangeDescriptors)) {
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor);
    else Reflect.deleteProperty(Range.prototype, key);
  }
});

describe("NotebookView prompt cells", () => {
  it("keeps an excluded cell's actions visible when the host offers the context toggle", async () => {
    await mount([excludedCode], { onSetCellMetadataAt: vi.fn() });

    expect(actionOverlay("code")).toHaveClass("opacity-100");
  });

  it("does not pin actions on excluded cells when the host has no context toggle", async () => {
    await mount([excludedCode], {});

    expect(actionOverlay("code")).toHaveClass("opacity-0");
  });

  it("runs an idle prompt with Shift+Enter", async () => {
    const onRunPromptCell = vi.fn();
    await mount([prompt], { onRunPromptCell, promptRuns: {} });

    pressShiftEnterIn("prompt");

    expect(onRunPromptCell).toHaveBeenCalledWith("prompt");
  });

  it("ignores Shift+Enter while the prompt is already running", async () => {
    const onRunPromptCell = vi.fn();
    await mount([prompt], {
      onRunPromptCell,
      promptRuns: { prompt: "2026-09-23T10:00:00Z" },
    });

    pressShiftEnterIn("prompt");

    expect(onRunPromptCell).not.toHaveBeenCalled();
  });
});
