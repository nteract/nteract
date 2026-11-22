import { createCommandRegistry, NotebookHostProvider } from "@nteract/notebook-host";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CrdtBridgeProvider } from "@/components/notebook/crdt-bridge";
import {
  flushCellUIState,
  setActiveInteractionTarget,
} from "@/components/notebook/state/cell-ui-state";
import { replaceNotebookCells } from "@/components/notebook/state/cell-store";
import {
  resetNotebookExecutions,
  setCellExecutionPointer,
  setExecution,
} from "@/components/notebook/state/execution-store";
import { resetNotebookOutputs, setOutput } from "@/components/notebook/state/output-store";
import { createFixtureNotebookHost } from "../../../../elements/components/fixture-notebook-host";
import type { NotebookCell } from "../../types";
import { NotebookView } from "../NotebookView";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ listen: async () => () => {}, setZoom: vi.fn() }),
}));
vi.mock("@/components/isolated/iframe-libraries", () => ({
  injectPluginsForMimes: vi.fn(async () => {}),
}));
vi.mock("@/components/isolated", async () => {
  const React = await import("react");
  return {
    IsolatedFrame: React.forwardRef(function IsolatedFrame() {
      return <iframe title="Markdown renderer" tabIndex={-1} />;
    }),
  };
});
vi.mock("@/components/cell/OutputArea", () => ({ OutputArea: () => null }));

const code: NotebookCell = {
  id: "a-code",
  cell_type: "code",
  source: "x = 1",
  execution_count: null,
  outputs: [],
  metadata: {},
};
const prompt: NotebookCell = {
  id: "b-prompt",
  cell_type: "raw",
  source: "what is x?",
  metadata: { nteract: { prompt: {} } },
};
const streamingAnswer: NotebookCell = {
  id: "c-answer",
  cell_type: "markdown",
  source: "",
  metadata: {
    nteract: {
      prompt_response: {
        prompt_cell_id: "b-prompt",
        execution_id: "exec-1",
        part: 0,
        streaming: true,
      },
    },
  },
};
const finishedAnswer: NotebookCell = {
  id: "d-answer",
  cell_type: "markdown",
  source: "x is one",
  metadata: {
    nteract: {
      prompt_response: {
        prompt_cell_id: "b-prompt",
        execution_id: "exec-1",
        part: 0,
        stopped: true,
      },
    },
  },
};

function mount(
  cells: NotebookCell[],
  props: Partial<React.ComponentProps<typeof NotebookView>> = {},
) {
  replaceNotebookCells(cells);
  const host = { ...createFixtureNotebookHost(), commands: createCommandRegistry() };
  const onExecuteCell = vi.fn();
  const onInterruptPrompt = vi.fn();
  const onInterruptKernel = vi.fn();
  render(
    <NotebookHostProvider host={host}>
      <CrdtBridgeProvider getHandle={() => null} onSyncNeeded={() => {}} localActor="prompt-test">
        <NotebookView
          cellIds={cells.map((cell) => cell.id)}
          autoFocusFirstCell={false}
          canAcceptCellMutations
          onFocusCell={() => {}}
          onExecuteCell={onExecuteCell}
          onInterruptKernel={onInterruptKernel}
          onInterruptPrompt={onInterruptPrompt}
          onDeleteCell={() => {}}
          onMoveCell={() => {}}
          onAddCell={() => null}
          {...props}
        />
      </CrdtBridgeProvider>
    </NotebookHostProvider>,
  );
  return { onExecuteCell, onInterruptPrompt, onInterruptKernel };
}

beforeEach(() => {
  setActiveInteractionTarget(null);
  resetNotebookExecutions();
  resetNotebookOutputs();
  replaceNotebookCells([]);
  flushCellUIState();
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
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotebookView prompt cells", () => {
  it("renders prompt cells as plain raw cells and answers as ordinary cells when the flag is off", () => {
    mount([code, prompt, finishedAnswer]);
    expect(document.querySelector('[data-slot="prompt-cell-header"]')).toBeNull();
    expect(document.querySelector('[data-slot="prompt-answer-label"]')).toBeNull();
    expect(screen.queryByTitle("Add prompt cell")).toBeNull();
    expect(document.querySelector('[data-cell-id="b-prompt"]')).toHaveAttribute(
      "data-cell-type",
      "raw",
    );
  });

  it("renders the prompt header and the run control when the flag is on", () => {
    const { onExecuteCell, onInterruptPrompt, onInterruptKernel } = mount([code, prompt], {
      promptCellsEnabled: true,
    });
    expect(document.querySelector('[data-cell-id="b-prompt"]')).toHaveAttribute(
      "data-cell-type",
      "ai",
    );
    const promptCell = document.querySelector('[data-cell-id="b-prompt"]') as HTMLElement;
    const control = () => within(promptCell).getByTestId("execute-button");
    fireEvent.click(control());
    expect(onExecuteCell).toHaveBeenCalledWith("b-prompt");

    act(() => {
      setExecution("exec-1", {
        execution_count: null,
        status: "running",
        success: null,
        output_ids: [],
        dispatched: true,
      });
      setCellExecutionPointer("b-prompt", "exec-1");
    });
    fireEvent.click(control());
    expect(onInterruptPrompt).toHaveBeenCalledWith("b-prompt");
    expect(onInterruptKernel).not.toHaveBeenCalled();
  });

  describe("deleting a prompt that has answers", () => {
    const openDialog = (cells = [code, prompt, finishedAnswer], onDeleteCell = vi.fn()) => {
      const onFocusCell = vi.fn();
      mount(cells, { promptCellsEnabled: true, onDeleteCell, onFocusCell });
      const promptCell = document.querySelector('[data-cell-id="b-prompt"]') as HTMLElement;
      fireEvent.click(within(promptCell).getByTitle("Delete cell"));
      return { dialog: screen.getByTestId("prompt-delete-dialog"), onDeleteCell, onFocusCell };
    };

    it("asks first and keeps the answers on Keep answers", () => {
      const { dialog, onDeleteCell } = openDialog();
      expect(dialog).toHaveTextContent("This prompt has an answer cell. Delete it too?");
      expect(onDeleteCell).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Keep answers" }));
      expect(onDeleteCell.mock.calls).toEqual([["b-prompt"]]);
    });

    it("deletes the answers and the prompt on Delete all and focuses a surviving cell", () => {
      const { dialog, onDeleteCell, onFocusCell } = openDialog([
        code,
        prompt,
        finishedAnswer,
        { ...code, id: "z-code" },
      ]);
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete all" }));
      expect(onDeleteCell.mock.calls).toEqual([["d-answer"], ["b-prompt"]]);
      expect(onFocusCell).toHaveBeenLastCalledWith("z-code");
    });

    it("focuses the cell before the prompt when no cell follows the answers", () => {
      const { dialog, onFocusCell } = openDialog();
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete all" }));
      expect(onFocusCell).toHaveBeenLastCalledWith("a-code");
    });

    it("deletes answers that arrive while the dialog is open", () => {
      const { dialog, onDeleteCell } = openDialog();
      act(() => {
        replaceNotebookCells([code, prompt, finishedAnswer, { ...finishedAnswer, id: "e-answer" }]);
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete all" }));
      expect(onDeleteCell.mock.calls).toEqual([["d-answer"], ["e-answer"], ["b-prompt"]]);
    });

    it("does nothing on Cancel and on Escape, and closes the dialog", async () => {
      const { dialog, onDeleteCell } = openDialog();
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("prompt-delete-dialog")).toBeNull());
      expect(onDeleteCell).not.toHaveBeenCalled();

      const promptCell = document.querySelector('[data-cell-id="b-prompt"]') as HTMLElement;
      fireEvent.click(within(promptCell).getByTitle("Delete cell"));
      fireEvent.click(
        within(screen.getByTestId("prompt-delete-dialog")).getByRole("button", { name: "Cancel" }),
      );
      await waitFor(() => expect(screen.queryByTestId("prompt-delete-dialog")).toBeNull());
      expect(onDeleteCell).not.toHaveBeenCalled();
    });

    it("keeps the answer count in the text while the dialog closes", () => {
      const { dialog } = openDialog([code, prompt, finishedAnswer, { ...finishedAnswer, id: "e" }]);
      expect(dialog).toHaveTextContent("This prompt has 2 answer cells.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(dialog.textContent).not.toContain("null");
      expect(dialog).toHaveTextContent("This prompt has 2 answer cells.");
    });
  });

  it("deletes a prompt without answers directly", () => {
    const onDeleteCell = vi.fn();
    mount([code, prompt], { promptCellsEnabled: true, onDeleteCell });
    const promptCell = document.querySelector('[data-cell-id="b-prompt"]') as HTMLElement;
    fireEvent.click(within(promptCell).getByTitle("Delete cell"));
    expect(screen.queryByTestId("prompt-delete-dialog")).toBeNull();
    expect(onDeleteCell).toHaveBeenCalledWith("b-prompt");
  });

  it("renders a kept answer as an ordinary cell once its prompt is gone", () => {
    mount([code, finishedAnswer], { promptCellsEnabled: true });
    expect(document.querySelector('[data-slot="prompt-answer-label"]')).toBeNull();
    expect(document.querySelector('[data-cell-id="d-answer"] .from-purple-200\\/30')).toBeNull();
  });

  it("draws an answer with a live prompt in the prompt tone", () => {
    mount([prompt, finishedAnswer], { promptCellsEnabled: true });
    expect(document.querySelector('[data-slot="prompt-answer-label"]')).not.toBeNull();
    expect(
      document.querySelector('[data-cell-id="d-answer"] [data-slot="cell-ribbon"]'),
    ).toHaveClass("from-purple-200/30");
  });

  it("shows the Prompt insertion button only with the flag on and a handler", () => {
    const onAddPromptCell = vi.fn(() => null);
    mount([code], { promptCellsEnabled: true, onAddPromptCell });
    fireEvent.click(screen.getAllByTitle("Add prompt cell")[0]);
    expect(onAddPromptCell).toHaveBeenCalledWith(null);
  });

  it("hides the Prompt insertion button when the flag is off even if a handler is passed", () => {
    mount([code], { onAddPromptCell: vi.fn(() => null) });
    expect(screen.queryByTitle("Add prompt cell")).toBeNull();
  });

  it("labels finished answer cells and marks a stopped run", () => {
    mount([prompt, finishedAnswer], { promptCellsEnabled: true });
    expect(document.querySelectorAll('[data-slot="prompt-answer-label"]')).toHaveLength(1);
    expect(screen.getByTestId("prompt-answer-stopped")).toBeInTheDocument();
  });

  it("renders the streaming placeholder from the execution output, read-only", () => {
    act(() => {
      setOutput("out-1", {
        output_id: "out-1",
        output_type: "display_data",
        data: { "text/markdown": "partial answer" },
      });
      setExecution("exec-1", {
        execution_count: null,
        status: "running",
        success: null,
        output_ids: ["out-1"],
        dispatched: true,
      });
    });
    mount([prompt, streamingAnswer], { promptCellsEnabled: true });
    expect(screen.getByTestId("prompt-answer-stream")).toHaveTextContent("partial answer");
    expect(document.querySelector('[data-cell-id="c-answer"] .cm-editor')).toBeNull();
  });

  it("draws the streaming placeholder as an ordinary cell once its prompt is gone", () => {
    act(() => {
      setOutput("out-1", {
        output_id: "out-1",
        output_type: "display_data",
        data: { "text/markdown": "partial answer" },
      });
      setExecution("exec-1", {
        execution_count: null,
        status: "running",
        success: null,
        output_ids: ["out-1"],
        dispatched: true,
      });
    });
    mount([streamingAnswer], { promptCellsEnabled: true });
    expect(screen.getByTestId("prompt-answer-stream")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="prompt-answer-label"]')).toBeNull();
    expect(document.querySelector('[data-slot="cell-ribbon"]')).not.toHaveClass(
      "from-purple-200/30",
    );
  });

  describe("Shift+Enter in a prompt", () => {
    const shiftEnter = () => {
      const content = document.querySelector(
        '[data-cell-id="b-prompt"] .cm-content',
      ) as HTMLElement;
      fireEvent.keyDown(content, { key: "Enter", code: "Enter", keyCode: 13, shiftKey: true });
    };

    it("runs the prompt and keeps the cursor in it", () => {
      const onFocusCell = vi.fn();
      const { onExecuteCell } = mount([prompt, { ...code, id: "z-code" }], {
        promptCellsEnabled: true,
        onFocusCell,
      });
      shiftEnter();
      expect(onExecuteCell).toHaveBeenCalledWith("b-prompt");
      expect(onFocusCell).not.toHaveBeenCalledWith("z-code");
    });

    it("moves on to the next cell like any cell when the prompt cannot run", () => {
      const onFocusCell = vi.fn();
      const { onExecuteCell } = mount([prompt, { ...code, id: "z-code" }], {
        promptCellsEnabled: true,
        capabilities: { canExecute: false },
        onFocusCell,
      });
      shiftEnter();
      expect(onExecuteCell).not.toHaveBeenCalled();
      expect(onFocusCell).toHaveBeenCalledWith("z-code");
    });
  });

  it("falls back to the normal answer cell when the placeholder has no live execution or the run ended without text", () => {
    mount([prompt, streamingAnswer], { promptCellsEnabled: true });
    expect(screen.queryByTestId("prompt-answer-stream")).toBeNull();
    expect(document.querySelectorAll('[data-slot="prompt-answer-label"]')).toHaveLength(1);
    expect(document.querySelector('[data-cell-id="c-answer"]')).not.toBeNull();
  });

  it("keeps the live view after the run ended until the answer text lands, and drops it when the stream is cancelled", () => {
    act(() => {
      setOutput("out-1", {
        output_id: "out-1",
        output_type: "display_data",
        data: { "text/markdown": "final text" },
      });
      setExecution("exec-1", {
        execution_count: null,
        status: "done",
        success: true,
        output_ids: ["out-1"],
        dispatched: true,
      });
    });
    mount([prompt, streamingAnswer], { promptCellsEnabled: true });
    expect(screen.getByTestId("prompt-answer-stream")).toHaveTextContent("final text");

    act(() => {
      setExecution("exec-1", {
        execution_count: null,
        status: "cancelled",
        success: null,
        output_ids: [],
        dispatched: true,
      });
    });
    expect(screen.queryByTestId("prompt-answer-stream")).toBeNull();
  });
});
