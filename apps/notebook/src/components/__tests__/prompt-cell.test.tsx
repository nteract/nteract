// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExecutionSnapshot } from "@/components/notebook/state/execution-store";
import {
  resetNotebookExecutions,
  setCellExecutionPointer,
  setExecution,
} from "@/components/notebook/state/execution-store";
import { resetNotebookOutputs, setOutput } from "@/components/notebook/state/output-store";
import { usePromptCellRunState } from "@/components/notebook/state/prompt-state";
import { PromptCellHeader, PromptRunControl } from "../PromptCellHeader";
import { PromptAnswerLabel, PromptAnswerStreamCell } from "../PromptAnswer";

vi.mock("@/components/cell/CellContainer", () => ({
  CellContainer: ({
    codeContent,
    rightGutterContent,
  }: {
    codeContent?: React.ReactNode;
    rightGutterContent?: React.ReactNode;
  }) => (
    <div data-testid="cell-container">
      {codeContent}
      {rightGutterContent}
    </div>
  ),
}));

vi.mock("@/components/notebook/state/cell-ui-state", () => ({
  useIsCellFocused: () => false,
  useIsPreviousCellFromFocused: () => false,
  useIsNextCellFromFocused: () => false,
}));

function execution(overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    execution_count: null,
    status: "queued",
    success: null,
    output_ids: [],
    ...overrides,
  };
}

describe("PromptCellHeader", () => {
  beforeEach(() => {
    resetNotebookExecutions();
    resetNotebookOutputs();
  });
  afterEach(cleanup);

  it("shows waiting for a queued prompt without context, then queued and running", () => {
    render(<PromptCellHeader cellId="prompt-1" />);
    expect(screen.queryByTestId("prompt-status")).toBeNull();
    act(() => {
      setExecution("e1", execution());
      setCellExecutionPointer("prompt-1", "e1");
    });
    expect(screen.getByTestId("prompt-status")).toHaveTextContent("waiting");

    act(() => setExecution("e1", execution({ dispatched: true })));
    expect(screen.getByTestId("prompt-status")).toHaveTextContent("queued");

    act(() => setExecution("e1", execution({ status: "running", dispatched: true })));
    expect(screen.getByTestId("prompt-status")).toHaveTextContent("running");
  });

  it("shows the PromptError message of a failed run", () => {
    act(() => {
      setOutput("o1", {
        output_id: "o1",
        output_type: "error",
        ename: "PromptError",
        evalue: "claude: command not found",
        traceback: [],
      });
      setExecution("e1", execution({ status: "error", output_ids: ["o1"] }));
      setCellExecutionPointer("prompt-1", "e1");
    });
    render(<PromptCellHeader cellId="prompt-1" />);
    expect(screen.getByTestId("prompt-error")).toHaveTextContent("claude: command not found");
    expect(screen.queryByTestId("prompt-outcome")).toBeNull();
  });

  it("shows Failed for an errored run without error output, and Stopped when the output says so", () => {
    act(() => {
      setExecution("e1", execution({ status: "error", output_ids: [] }));
      setCellExecutionPointer("prompt-1", "e1");
    });
    render(<PromptCellHeader cellId="prompt-1" />);
    expect(screen.getByTestId("prompt-outcome")).toHaveTextContent("Failed");

    act(() => {
      setOutput("o-stop", {
        output_id: "o-stop",
        output_type: "display_data",
        data: { "text/markdown": "partial" },
        metadata: { nteract: { prompt_stopped: true } },
      });
      setExecution("e1", execution({ status: "error", output_ids: ["o-stop"] }));
    });
    expect(screen.getByTestId("prompt-outcome")).toHaveTextContent("Stopped");
    expect(screen.queryByTestId("prompt-error")).toBeNull();
  });

  it("does not re-render the run state for output rewrites while a run streams", () => {
    let renders = 0;
    act(() => {
      setOutput("o1", {
        output_id: "o1",
        output_type: "display_data",
        data: { "text/markdown": "a" },
      });
      setExecution("e1", execution({ status: "running", output_ids: ["o1"] }));
      setCellExecutionPointer("prompt-1", "e1");
    });
    function Harness() {
      renders += 1;
      usePromptCellRunState("prompt-1");
      return null;
    }
    render(<Harness />);
    const before = renders;
    act(() => {
      setOutput("o1", {
        output_id: "o1",
        output_type: "display_data",
        data: { "text/markdown": "ab" },
      });
    });
    expect(renders).toBe(before);
  });
});

describe("PromptRunControl", () => {
  beforeEach(() => {
    resetNotebookExecutions();
    resetNotebookOutputs();
  });
  afterEach(cleanup);

  it("runs when idle and stops in every active state, like a code cell's control", () => {
    const onRun = vi.fn();
    const onStop = vi.fn();
    render(<PromptRunControl cellId="prompt-1" isCellFocused onRun={onRun} onStop={onStop} />);
    const button = () => screen.getByTestId("execute-button");
    expect(button()).toHaveAttribute("data-execution-state", "idle");
    fireEvent.click(button());
    expect(onRun).toHaveBeenCalledTimes(1);

    // Waiting for the cells above (no context yet) already shows as running and can be stopped.
    act(() => {
      setExecution("e1", execution());
      setCellExecutionPointer("prompt-1", "e1");
    });
    expect(button()).toHaveAttribute("data-execution-state", "running");
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledTimes(1);

    act(() => setExecution("e1", execution({ status: "error" })));
    expect(button()).toHaveAttribute("data-execution-state", "error");
  });

  it("is a read-only readout without a run handler", () => {
    render(<PromptRunControl cellId="prompt-1" isCellFocused={false} />);
    expect(screen.queryByTestId("execute-button")).toBeNull();
  });

  it("is not clickable while active without a stop handler", () => {
    act(() => {
      setExecution("e1", execution({ status: "running" }));
      setCellExecutionPointer("prompt-1", "e1");
    });
    render(<PromptRunControl cellId="prompt-1" isCellFocused onRun={vi.fn()} />);
    expect(screen.queryByTestId("execute-button")).toBeNull();
    expect(screen.getByTestId("execution-readout")).toHaveAttribute(
      "data-execution-state",
      "running",
    );
  });

  it("does not describe a stopped run as cancelled before it ran", () => {
    act(() => {
      setOutput("o-stop", {
        output_id: "o-stop",
        output_type: "display_data",
        data: { "text/markdown": "partial" },
        metadata: { nteract: { prompt_stopped: true } },
      });
      setExecution("e1", execution({ status: "error", output_ids: ["o-stop"] }));
      setCellExecutionPointer("prompt-1", "e1");
    });
    render(<PromptRunControl cellId="prompt-1" isCellFocused onRun={vi.fn()} onStop={vi.fn()} />);
    const button = screen.getByTestId("execute-button");
    expect(button).not.toHaveAttribute("data-execution-state", "cancelled");
    expect(button.getAttribute("title")).not.toMatch(/cancelled/);
  });
});

describe("answer cells", () => {
  beforeEach(() => {
    resetNotebookExecutions();
    resetNotebookOutputs();
  });
  afterEach(cleanup);

  it("labels an answer, jumps to the prompt and marks a stopped run", () => {
    const onJump = vi.fn();
    const { rerender } = render(<PromptAnswerLabel onJumpToPrompt={onJump} />);
    expect(screen.queryByTestId("prompt-answer-stopped")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /answer to/i }));
    expect(onJump).toHaveBeenCalledTimes(1);

    rerender(<PromptAnswerLabel stopped />);
    expect(screen.getByTestId("prompt-answer-stopped")).toHaveTextContent("stopped");
  });

  it("renders the live text/markdown output of the execution while streaming", () => {
    act(() => {
      setOutput("o1", {
        output_id: "o1",
        output_type: "display_data",
        data: { "text/markdown": "Hello **world**" },
      });
      setExecution("e1", execution({ status: "running", output_ids: ["o1"] }));
    });
    render(
      <PromptAnswerStreamCell
        cellId="answer-1"
        promptCellId={null}
        executionId="e1"
        hasSource={false}
        fallback={null}
        onFocus={vi.fn()}
      />,
    );
    expect(screen.getByTestId("prompt-answer-stream")).toHaveTextContent("Hello **world**");

    act(() => {
      setOutput("o1", {
        output_id: "o1",
        output_type: "display_data",
        data: { "text/markdown": "Hello **world**, more" },
      });
    });
    expect(screen.getByTestId("prompt-answer-stream")).toHaveTextContent("more");
  });

  it("shows a placeholder before the first text arrives", () => {
    act(() => setExecution("e1", execution({ status: "running" })));
    render(
      <PromptAnswerStreamCell
        cellId="answer-1"
        promptCellId={null}
        executionId="e1"
        hasSource={false}
        fallback={null}
        onFocus={vi.fn()}
      />,
    );
    expect(screen.getByTestId("prompt-answer-stream")).toHaveTextContent("Thinking");
  });
});
