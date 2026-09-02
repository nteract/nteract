import { EditorView } from "@codemirror/view";
import { NotebookHostProvider } from "@nteract/notebook-host";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CrdtBridgeProvider } from "@/components/notebook/crdt-bridge";
import {
  flushCellUIState,
  getActiveInteractionTarget,
  setActiveInteractionTarget,
  setSearchCurrentMatch,
  setSearchQuery,
} from "@/components/notebook/state/cell-ui-state";
import { replaceNotebookCells } from "@/components/notebook/state/cell-store";
import { resetNotebookExecutions } from "@/components/notebook/state/execution-store";
import { resetNotebookOutputs } from "@/components/notebook/state/output-store";
import { clearOutputFocusedCellId } from "@/components/notebook/state/output-focus-store";
import { createFixtureNotebookHost } from "../../../../elements/components/fixture-notebook-host";
import type { NotebookCell } from "../../types";
import { NotebookView } from "../NotebookView";

vi.mock("@/components/isolated/iframe-libraries", () => ({
  injectPluginsForMimes: vi.fn(async () => {}),
}));

vi.mock("@/components/isolated", async () => {
  const React = await import("react");
  return {
    IsolatedFrame: React.forwardRef(function IsolatedFrame(props: { onReady?: () => void }, ref) {
      React.useImperativeHandle(ref, () => ({
        send: vi.fn(),
        render: vi.fn(),
        renderBatch: vi.fn(),
        eval: vi.fn(),
        installRenderer: vi.fn(),
        setTheme: vi.fn(),
        setHostContext: vi.fn(),
        clear: vi.fn(),
        search: vi.fn(),
        searchNavigate: vi.fn(),
        measureElement: vi.fn(async () => null),
        isReady: true,
        isIframeReady: true,
      }));
      React.useEffect(() => props.onReady?.(), [props.onReady]);
      return <iframe title="Markdown renderer" tabIndex={-1} />;
    }),
    useBokehSessionRuntime: () => null,
  };
});

vi.mock("@/components/cell/OutputArea", () => ({ OutputArea: () => null }));

const markdown: NotebookCell = {
  id: "z-markdown",
  cell_type: "markdown",
  source: "# Command focus",
  metadata: {},
};
const code: NotebookCell = {
  id: "a-code",
  cell_type: "code",
  source: "answer = 42",
  execution_count: null,
  outputs: [],
  metadata: {},
};
const raw: NotebookCell = {
  id: "m-raw",
  cell_type: "raw",
  source: "raw content",
  metadata: {},
};

function resetStores() {
  setActiveInteractionTarget(null);
  setSearchCurrentMatch(null);
  setSearchQuery(undefined);
  clearOutputFocusedCellId();
  resetNotebookExecutions();
  resetNotebookOutputs();
  replaceNotebookCells([]);
  flushCellUIState();
}

async function settleFocus() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function press(key: string, modifiers: KeyboardEventInit = {}) {
  const allowedDefault = fireEvent.keyDown(document.activeElement ?? document.body, {
    key,
    ...modifiers,
  });
  await settleFocus();
  return allowedDefault;
}

async function mountNotebook(cells: NotebookCell[] = [markdown, code, raw]) {
  replaceNotebookCells(cells);
  const onAddCell = vi.fn(() => null);
  const host = createFixtureNotebookHost();
  const notebook = (currentCells: NotebookCell[], isLoading = false) => (
    <NotebookHostProvider host={host}>
      <CrdtBridgeProvider getHandle={() => null} onSyncNeeded={() => {}} localActor="focus-test">
        <NotebookView
          cellIds={currentCells.map((cell) => cell.id)}
          isLoading={isLoading}
          autoFocusFirstCell={false}
          canAcceptCellMutations
          onFocusCell={() => {}}
          onExecuteCell={() => {}}
          onInterruptKernel={() => {}}
          onDeleteCell={() => {}}
          onMoveCell={() => {}}
          onAddCell={onAddCell}
        />
      </CrdtBridgeProvider>
    </NotebookHostProvider>
  );
  const view = render(notebook(cells));
  await settleFocus();
  expect(screen.queryByText("This cell encountered an error")).toBeNull();
  const rerenderCells = async (nextCells: NotebookCell[], isLoading = false) => {
    act(() => {
      replaceNotebookCells(nextCells);
      view.rerender(notebook(nextCells, isLoading));
    });
    await settleFocus();
    expect(screen.queryByText("This cell encountered an error")).toBeNull();
  };
  return { onAddCell, rerenderCells };
}

async function selectCell(cellId: string) {
  act(() => {
    setActiveInteractionTarget({ kind: "cell", cellId });
    flushCellUIState();
  });
  await settleFocus();
}

function expectCommandFocus(cellId: string) {
  expect(getActiveInteractionTarget()).toEqual({ kind: "cell", cellId });
  const target = document.querySelector<HTMLElement>(`[data-cell-command-focus="${cellId}"]`);
  expect(target).not.toBeNull();
  expect(target?.getAttribute("role")).toBe("group");
  expect(screen.getAllByRole("group", { name: /\S/ })).toContain(target);
  expect(target?.getAttribute("tabindex")).toBe("0");
  expect(
    [...document.querySelectorAll<HTMLElement>("[data-cell-command-focus]")].filter(
      (cellTarget) => cellTarget.tabIndex === 0,
    ),
  ).toEqual([target]);
  expect(document.activeElement).toBe(target);
}

function expectEditorFocus(cellId: string) {
  expect(getActiveInteractionTarget()).toEqual({ kind: "editor", cellId });
  const content = document.querySelector<HTMLElement>(`[data-cell-id="${cellId}"] .cm-content`);
  expect(content).not.toBeNull();
  expect(document.activeElement).toBe(content);
  expect(EditorView.findFromDOM(content!)).not.toBeNull();
}

const domPolyfills: Array<[object, string, PropertyDescriptor | undefined]> = [];

function polyfill(target: object, key: string, descriptor: PropertyDescriptor) {
  domPolyfills.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
}

beforeEach(() => {
  resetStores();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
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
  polyfill(HTMLElement.prototype, "scrollIntoView", { value: vi.fn() });
  polyfill(HTMLElement.prototype, "isContentEditable", {
    get(this: HTMLElement) {
      return this.closest("[contenteditable]")?.getAttribute("contenteditable") === "true";
    },
  });
  polyfill(Range.prototype, "getClientRects", { value: () => [] });
  polyfill(Range.prototype, "getBoundingClientRect", { value: () => new DOMRect() });
});

afterEach(() => {
  cleanup();
  resetStores();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [target, key, descriptor] of domPolyfills.splice(0).reverse()) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
});

describe("NotebookView command focus", () => {
  it.each([code, raw, markdown])(
    "cycles Enter/Escape between command focus and the real $cell_type editor",
    async (cell) => {
      await mountNotebook();
      await selectCell(cell.id);
      expectCommandFocus(cell.id);
      for (let cycle = 0; cycle < 2; cycle++) {
        await press("Enter");
        expectEditorFocus(cell.id);
        await press("Escape");
        expectCommandFocus(cell.id);
      }
    },
  );

  it.each(["ArrowDown", "j"])(
    "keeps code selected through Escape after leaving an explicitly focused Markdown preview with %s",
    async (next) => {
      await mountNotebook();
      await selectCell(markdown.id);
      const preview = screen.getByRole("textbox", { name: "Markdown cell content" });
      act(() => preview.focus());
      expect(document.activeElement).toBe(preview);
      expect(getActiveInteractionTarget()).toEqual({ kind: "cell", cellId: markdown.id });

      await press(next);
      expect(getActiveInteractionTarget()).toEqual({ kind: "cell", cellId: code.id });
      expect.soft(document.activeElement).not.toBe(preview);
      await press("Escape");
      expect.soft(getActiveInteractionTarget()).toEqual({ kind: "cell", cellId: code.id });
      expect.soft(document.activeElement?.getAttribute("data-cell-command-focus")).toBe(code.id);
      await press("Enter");
      expectEditorFocus(code.id);
    },
  );

  it("allows explicit Markdown preview focus from a different selected cell", async () => {
    await mountNotebook();
    await selectCell(code.id);
    expectCommandFocus(code.id);
    const preview = screen.getByRole("textbox", { name: "Markdown cell content" });

    act(() => preview.focus());
    await settleFocus();
    expect(getActiveInteractionTarget()).toEqual({ kind: "cell", cellId: markdown.id });
    expect(document.activeElement).toBe(preview);
    await press("Enter");
    expectEditorFocus(markdown.id);
    await press("Escape");
    expectCommandFocus(markdown.id);
  });

  it("synchronizes selection when an inactive command wrapper receives direct focus", async () => {
    await mountNotebook();
    await selectCell(code.id);
    expectCommandFocus(code.id);
    const rawTarget = document.querySelector<HTMLElement>(`[data-cell-command-focus="${raw.id}"]`);
    expect(rawTarget).not.toBeNull();

    act(() => rawTarget?.focus());
    await settleFocus();

    expectCommandFocus(raw.id);
  });

  it("keeps Shift+Enter in command mode", async () => {
    await mountNotebook();
    await selectCell(markdown.id);

    expect(await press("Enter", { shiftKey: true })).toBe(true);
    expectCommandFocus(markdown.id);
  });

  it.each(["input", "button"])("does not hijack keys from a focused %s", async (controlType) => {
    const { onAddCell } = await mountNotebook();
    render(
      controlType === "input" ? (
        <input aria-label="Notebook search" />
      ) : (
        <button type="button">Notebook action</button>
      ),
    );
    await selectCell(code.id);
    expectCommandFocus(code.id);
    const control =
      controlType === "input"
        ? screen.getByRole("textbox", { name: "Notebook search" })
        : screen.getByRole("button", { name: "Notebook action" });
    act(() => control.focus());

    for (const key of ["ArrowDown", "ArrowUp", "j", "k", "Enter", "Escape", "a", "b", "d", "d"]) {
      expect(await press(key)).toBe(true);
      expect(getActiveInteractionTarget()).toEqual({ kind: "cell", cellId: code.id });
      expect(document.activeElement).toBe(control);
    }
    expect(onAddCell).not.toHaveBeenCalled();
  });

  it.each(["reordered", "inserted"])(
    "preserves external input focus when cells are %s without changing the selection",
    async (change) => {
      const { rerenderCells } = await mountNotebook();
      render(<input aria-label="Notebook search" />);
      await selectCell(code.id);
      expectCommandFocus(code.id);
      const selection = getActiveInteractionTarget();
      const commandTarget = document.activeElement;
      const input = screen.getByRole("textbox", { name: "Notebook search" });
      act(() => input.focus());
      expect(document.activeElement).toBe(input);

      const inserted: NotebookCell = { ...code, id: "inserted-code" };
      const nextCells =
        change === "reordered" ? [raw, markdown, code] : [markdown, inserted, code, raw];
      await rerenderCells(nextCells);

      expect(getActiveInteractionTarget()).toBe(selection);
      expect(getActiveInteractionTarget()).toEqual({ kind: "cell", cellId: code.id });
      expect(document.activeElement).toBe(input);
      const retainedTarget = document.querySelector<HTMLElement>(
        `[data-cell-command-focus="${code.id}"]`,
      );
      expect(retainedTarget).toBe(commandTarget);
      expect(retainedTarget?.style.order).toBe(String(nextCells.indexOf(code)));
      if (change === "inserted") {
        expect(document.querySelector('[data-cell-command-focus="inserted-code"]')).not.toBeNull();
      }
    },
  );

  it("preserves external input focus across loading transitions", async () => {
    const { rerenderCells } = await mountNotebook();
    render(<input aria-label="Notebook search" />);
    await selectCell(code.id);
    const input = screen.getByRole("textbox", { name: "Notebook search" });
    act(() => input.focus());

    for (const isLoading of [true, false]) {
      await rerenderCells([markdown, code, raw], isLoading);
      expect(getActiveInteractionTarget()).toEqual({ kind: "cell", cellId: code.id });
      expect(document.activeElement).toBe(input);
    }
  });

  it("focuses a deferred command selection when the selected cell is inserted", async () => {
    const { rerenderCells } = await mountNotebook();
    await selectCell(code.id);
    expectCommandFocus(code.id);
    const inserted: NotebookCell = { ...code, id: "deferred-code" };
    await selectCell(inserted.id);
    const selection = getActiveInteractionTarget();
    expect(selection).toEqual({ kind: "cell", cellId: inserted.id });
    expect(document.querySelector('[data-cell-command-focus="deferred-code"]')).toBeNull();

    await rerenderCells([markdown, code, inserted, raw]);

    expect(getActiveInteractionTarget()).toBe(selection);
    expectCommandFocus(inserted.id);
    await press("Enter");
    expectEditorFocus(inserted.id);
  });

  it.each(["ctrlKey", "metaKey", "altKey", "shiftKey"] as const)(
    "rejects command navigation with %s",
    async (modifier) => {
      const { onAddCell } = await mountNotebook();
      await selectCell(code.id);
      const keys = ["ArrowDown", "ArrowUp", "j", "k"];
      if (modifier !== "shiftKey") keys.push("Enter", "a", "b");
      for (const key of keys) {
        expect(await press(key, { [modifier]: true })).toBe(true);
        expectCommandFocus(code.id);
      }
      expect(onAddCell).not.toHaveBeenCalled();
    },
  );

  it("never automatically focuses Markdown preview on command selection", async () => {
    await mountNotebook();
    const preview = screen.getByRole("textbox", { name: "Markdown cell content" });
    const previewFocus = vi.fn();
    preview.addEventListener("focus", previewFocus);
    await selectCell(code.id);
    await press("ArrowUp");
    expect(getActiveInteractionTarget()).toEqual({ kind: "cell", cellId: markdown.id });
    expect(previewFocus).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(preview);
    expectCommandFocus(markdown.id);
  });

  it.each([
    ["ArrowDown", "ArrowUp"],
    ["j", "k"],
    ["J", "K"],
  ])(
    "uses %s/%s for command navigation and preserves notebook boundaries",
    async (next, previous) => {
      const { onAddCell } = await mountNotebook();
      await selectCell(markdown.id);
      await press(previous);
      expectCommandFocus(markdown.id);
      await press(next);
      expectCommandFocus(code.id);
      await press(next);
      expectCommandFocus(raw.id);
      await press(next);
      expectCommandFocus(raw.id);
      expect(onAddCell).not.toHaveBeenCalled();
      await press("Enter");
      expectEditorFocus(raw.id);
      await press("Escape");
      expectCommandFocus(raw.id);
      await press(previous);
      expectCommandFocus(code.id);
      await press(previous);
      expectCommandFocus(markdown.id);
    },
  );

  it.each([
    ["ArrowDown", "ArrowUp"],
    ["j", "k"],
  ])(
    "skips collapsed group members with %s/%s while retaining the group leader",
    async (next, previous) => {
      const hidden = (id: string): NotebookCell => ({
        ...code,
        id,
        metadata: { jupyter: { source_hidden: true, outputs_hidden: true } },
      });
      await mountNotebook([markdown, hidden("hidden-first"), hidden("hidden-second"), raw]);
      expect(document.querySelector('[data-cell-id="hidden-second"]')).toBeNull();
      await selectCell(markdown.id);
      await press(next);
      expectCommandFocus("hidden-first");
      await press(next);
      expectCommandFocus(raw.id);
      await press(previous);
      expectCommandFocus("hidden-first");
      await press(previous);
      expectCommandFocus(markdown.id);
    },
  );
});
