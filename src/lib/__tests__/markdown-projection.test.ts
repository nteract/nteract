import initMarkdownWasm from "../../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import {
  canRenderMarkdownProjectionInHost,
  projectMarkdownPlan,
} from "../markdown-projection";

describe("markdown projection", () => {
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

  it("projects GFM task state from literal markdown source", () => {
    const plan = projectMarkdownPlan("- [x] done\n- [ ] waiting\n- regular\n");

    expect(plan?.blocks[0]?.kind).toBe("list");
    expect(
      plan?.runs
        .filter((run) => run.semantic === "list-item")
        .map((run) => ({
          checked: run.listItemChecked,
          text: run.renderedText,
        })),
    ).toEqual([
      { checked: true, text: "done" },
      { checked: false, text: "waiting" },
      { checked: undefined, text: "regular" },
    ]);
  });

  it("projects inline and display math without markdown delimiters", () => {
    const plan = projectMarkdownPlan("Inline $x^2$.\n\n$$\n\\int_0^1 x dx\n$$\n");

    expect(
      plan?.runs
        .filter((run) => run.semantic === "math-source")
        .map((run) => run.renderedText),
    ).toEqual(["x^2", "\\int_0^1 x dx"]);
    expect(plan?.blocks.map((block) => block.kind)).toContain("math");
  });

  it("keeps projected raw HTML out of the host renderer", () => {
    const plan = projectMarkdownPlan("alpha <i>wow</i> omega");

    expect(plan?.runs.some((run) => run.renderedHtml)).toBe(true);
    expect(canRenderMarkdownProjectionInHost(plan)).toBe(false);
  });
});
