import { readFileSync } from "node:fs";
import { join } from "node:path";
import initMarkdownWasm from "../../wasm/runtimed-wasm/runtimed_wasm.js";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { projectMarkdownPlan } from "../markdown-projection";
import { toggleMarkdownTaskMarker } from "../markdown-task-source";

describe("toggleMarkdownTaskMarker", () => {
  beforeAll(async () => {
    const wasmBytes = readFileSync(
      join(process.cwd(), "apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm"),
    );
    await initMarkdownWasm({
      module_or_path: wasmBytes.buffer.slice(
        wasmBytes.byteOffset,
        wasmBytes.byteOffset + wasmBytes.byteLength,
      ),
    });
  });

  it("uses projected WASM task spans to update literal markdown source", () => {
    const source = "- [ ] ship checkboxes\n- [x] keep outputs read-only";
    const plan = projectMarkdownPlan(source);
    const waitingRun = plan?.runs.find((run) => run.renderedText === "ship checkboxes");

    expect(waitingRun).toEqual(
      expect.objectContaining({
        listItemChecked: false,
        semantic: "list-item",
      }),
    );
    expect(toggleMarkdownTaskMarker(source, waitingRun!, true)).toBe(
      "- [x] ship checkboxes\n- [x] keep outputs read-only",
    );
  });

  it("checks an unchecked task marker within the projected source span", () => {
    const source = "- [ ] ship checkboxes\n- [x] keep outputs read-only";

    expect(
      toggleMarkdownTaskMarker(source, { sourceSpanUtf16: [0, 21] }, true),
    ).toBe("- [x] ship checkboxes\n- [x] keep outputs read-only");
  });

  it("checks an unchecked task marker when the projected source span is only the task text", () => {
    const source = "- [ ] ship checkboxes\n- [x] keep outputs read-only";

    expect(
      toggleMarkdownTaskMarker(source, { sourceSpanUtf16: [6, 20] }, true),
    ).toBe("- [x] ship checkboxes\n- [x] keep outputs read-only");
  });

  it("unchecks a checked task marker without touching neighboring list items", () => {
    const source = "- [ ] first\n- [X] second\n- [x] third";

    expect(
      toggleMarkdownTaskMarker(source, { sourceSpanUtf16: [12, 24] }, false),
    ).toBe("- [ ] first\n- [ ] second\n- [x] third");
  });

  it("returns null when the source span does not include a task marker", () => {
    expect(
      toggleMarkdownTaskMarker("- regular list item", { sourceSpanUtf16: [0, 19] }, true),
    ).toBeNull();
  });
});
