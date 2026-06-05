import initMarkdownWasm from "../../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import {
  canRenderMarkdownProjectionInHost,
  findMarkdownProjectionAtSourcePosition,
  projectMarkdownPlan,
} from "../markdown-projection";

function readMarkdownFixture(name: string): string {
  return readFileSync(
    join(process.cwd(), "src/lib/__tests__/fixtures", name),
    "utf8",
  );
}

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

  it("projects bare Jupyter TeX environments as display math", () => {
    const source = [
      "\\begin{align}",
      "a^2 + b^2 &= c^2 \\\\",
      "\\sin^2(\\theta) + \\cos^2(\\theta) &= 1",
      "\\end{align}",
      "",
      "\\begin{equation*}",
      "x = y",
      "\\end{equation*}",
    ].join("\n");
    const plan = projectMarkdownPlan(source);

    expect(plan?.blocks.map((block) => block.kind)).toEqual(["math", "math"]);
    expect(plan?.blocks.map((block) => block.text)).toEqual([
      [
        "\\begin{align}",
        "a^2 + b^2 &= c^2 \\\\",
        "\\sin^2(\\theta) + \\cos^2(\\theta) &= 1",
        "\\end{align}",
      ].join("\n"),
      "\\begin{equation*}\nx = y\n\\end{equation*}",
    ]);
    expect(
      plan?.runs
        .filter((run) => run.semantic === "math-source")
        .map((run) => run.renderedText),
    ).toEqual(plan?.blocks.map((block) => block.text));
  });

  it("projects mixed prose and bare TeX environments into ordered blocks", () => {
    const source = readMarkdownFixture("mixed-tex-proof.md");
    const plan = projectMarkdownPlan(source);

    expect(plan?.blocks.map((block) => ({
      kind: block.kind,
      text: block.text,
    }))).toEqual([
      {
        kind: "heading",
        text: "A tidy little proof",
      },
      {
        kind: "paragraph",
        text: "Suppose sqrt(2) is rational, so \\sqrt{2}=p/q for integers in lowest terms.",
      },
      {
        kind: "math",
        text: [
          "\\begin{align}",
          "\\sqrt{2} &= \\frac{p}{q} \\\\",
          "2q^2 &= p^2",
          "\\end{align}",
        ].join("\n"),
      },
      {
        kind: "paragraph",
        text: "The equation shows p is even, so write p = 2k.",
      },
      {
        kind: "math",
        text: "\\begin{equation}\nq^2 = 2k^2\n\\end{equation}",
      },
      {
        kind: "paragraph",
        text: "Now q is even too, contradicting that p/q was in lowest terms.",
      },
      {
        kind: "list",
        text: "Plain prose stays paragraph text.Bare TeX environments become math blocks.",
      },
    ]);
    expect(
      plan?.runs
        .filter((run) => run.semantic === "math-source")
        .map((run) => run.renderedText),
    ).toEqual([
      "\\sqrt{2}=p/q",
      [
        "\\begin{align}",
        "\\sqrt{2} &= \\frac{p}{q} \\\\",
        "2q^2 &= p^2",
        "\\end{align}",
      ].join("\n"),
      "\\begin{equation}\nq^2 = 2k^2\n\\end{equation}",
    ]);
    expect(
      plan?.runs
        .filter((run) => run.semantic === "list-item")
        .map((run) => run.renderedText),
    ).toEqual([
      "Plain prose stays paragraph text.",
      "Bare TeX environments become math blocks.",
    ]);
  });

  it("keeps projected raw HTML markup out of the host DOM without forcing iframe fallback", () => {
    const plan = projectMarkdownPlan("alpha <i>wow</i> omega");

    expect(plan?.runs.some((run) => run.renderedHtml)).toBe(true);
    expect(canRenderMarkdownProjectionInHost(plan)).toBe(true);
  });

  it("keeps projected raw HTML blocks host-renderable as omitted placeholders", () => {
    const plan = projectMarkdownPlan('<button id="raw">raw html stays omitted</button>');

    expect(plan?.runs.some((run) => run.semantic === "isolated-placeholder")).toBe(true);
    expect(canRenderMarkdownProjectionInHost(plan)).toBe(true);
  });

  it("maps source cursor positions back to projected rendered blocks and runs", () => {
    const source = "# Heading\n\nA paragraph with **focus**.\n\n- [ ] checkbox\n";
    const plan = projectMarkdownPlan(source);
    const focusPosition = source.indexOf("focus") + 2;
    const checkboxPosition = source.indexOf("checkbox") + 2;

    expect(
      findMarkdownProjectionAtSourcePosition(plan, focusPosition),
    ).toEqual(
      expect.objectContaining({
        block: expect.objectContaining({
          kind: "paragraph",
          text: "A paragraph with focus.",
        }),
        position: focusPosition,
        run: expect.objectContaining({
          renderedText: "focus",
          semantic: "strong",
        }),
      }),
    );
    expect(
      findMarkdownProjectionAtSourcePosition(plan, checkboxPosition),
    ).toEqual(
      expect.objectContaining({
        block: expect.objectContaining({
          kind: "list",
          text: "checkbox",
        }),
        run: expect.objectContaining({
          listItemChecked: false,
          renderedText: "checkbox",
          semantic: "list-item",
        }),
      }),
    );
  });
});
