import { describe, expect, it } from "vite-plus/test";
import {
  derivePromptRunView,
  isPromptCell,
  promptErrorMessage,
  promptMarkdownText,
  promptResponse,
  promptStoppedMarker,
} from "../prompt-cells";

function cell(id: string, cell_type: string, metadata: Record<string, unknown> = {}) {
  return { id, cell_type, metadata };
}

describe("prompt cell recognition", () => {
  it("recognizes raw cells with an object at nteract.prompt", () => {
    expect(isPromptCell(cell("p", "raw", { nteract: { prompt: {} } }))).toBe(true);
    expect(isPromptCell(cell("p", "raw", { nteract: { prompt: { mode: "x" } } }))).toBe(true);
    expect(isPromptCell(cell("r", "raw"))).toBe(false);
    expect(isPromptCell(cell("c", "code", { nteract: { prompt: {} } }))).toBe(false);
    expect(isPromptCell(cell("p", "raw", { nteract: { prompt: true } }))).toBe(false);
    expect(isPromptCell({ cell_type: "raw" })).toBe(false);
  });

  it("reads the prompt_response of answer cells", () => {
    const answer = cell("a", "markdown", {
      nteract: {
        prompt_response: { prompt_cell_id: "p", execution_id: "e1", streaming: true },
      },
    });
    expect(promptResponse(answer)).toEqual({
      promptCellId: "p",
      executionId: "e1",
      streaming: true,
      stopped: false,
    });
    expect(
      promptResponse(
        cell("a", "code", { nteract: { prompt_response: { prompt_cell_id: "p", stopped: true } } }),
      ),
    ).toMatchObject({ streaming: false, stopped: true, executionId: null });
    expect(promptResponse(cell("m", "markdown"))).toBeNull();
  });
});

describe("derivePromptRunView", () => {
  it("maps the execution status to the header state", () => {
    expect(derivePromptRunView(undefined)).toEqual({ status: "idle", failed: false });
    // Queued but not dispatched: the context is not built yet.
    expect(derivePromptRunView({ status: "queued" })).toEqual({ status: "waiting", failed: false });
    expect(derivePromptRunView({ status: "queued", dispatched: true }).status).toBe("queued");
    expect(derivePromptRunView({ status: "running" }).status).toBe("running");
    expect(derivePromptRunView({ status: "error" })).toEqual({ status: "idle", failed: true });
    expect(derivePromptRunView({ status: "cancelled" })).toEqual({ status: "idle", failed: false });
    expect(derivePromptRunView({ status: "done" })).toEqual({ status: "idle", failed: false });
  });
});

describe("prompt outputs", () => {
  it("extracts the PromptError message", () => {
    expect(
      promptErrorMessage([
        { output_type: "error", ename: "PromptError", evalue: "claude: command not found" },
      ]),
    ).toBe("claude: command not found");
    expect(promptErrorMessage([{ output_type: "error", ename: "PromptError", evalue: " " }])).toBe(
      "PromptError",
    );
    expect(promptErrorMessage([{ output_type: "display_data", data: {} } as never])).toBeNull();
  });

  it("extracts the text/markdown payload of the live output", () => {
    expect(
      promptMarkdownText([
        { output_type: "stream" },
        { output_type: "display_data", data: { "text/markdown": "# Hi" } },
      ]),
    ).toBe("# Hi");
    expect(
      promptMarkdownText([{ output_type: "display_data", data: { "text/markdown": ["a", "b"] } }]),
    ).toBe("ab");
    expect(promptMarkdownText([])).toBe("");
  });

  it("detects the stopped marker on an output", () => {
    expect(
      promptStoppedMarker([
        { output_type: "display_data", metadata: { nteract: { prompt_stopped: true } } },
      ]),
    ).toBe(true);
    expect(promptStoppedMarker([{ output_type: "display_data", metadata: {} }])).toBe(false);
    expect(promptStoppedMarker([])).toBe(false);
  });
});
