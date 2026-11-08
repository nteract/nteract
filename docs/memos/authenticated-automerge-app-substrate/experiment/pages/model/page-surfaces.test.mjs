import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as A from "@automerge/automerge";
import { build } from "esbuild";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { pagePreview } from "./page-preview.mjs";
import { cardContent } from "./page-card.mjs";
import { openingTitleWarning } from "./title-warning.mjs";
import { RICH_FORMAT } from "./richtext-format.mjs";
import { encode } from "./wordgard-doc.mjs";
import { SHAPES, PAGE_ID } from "../test/address-inputs.mjs";
import { pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";

const BASE = "943115c13706ab28b6bd1ddda775e57f3acf1b65";
const GOLDEN = new URL("./page-surfaces.golden.json", import.meta.url);
const require = createRequire(import.meta.url);
const modelPath = "docs/memos/authenticated-automerge-app-substrate/experiment/pages/model/";
const modules = ["page-preview.mjs", "page-card.mjs", "title-warning.mjs"];
const current = { pagePreview, cardContent, openingTitleWarning };
const externalPackages = {
  name: "external-packages",
  setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
      path: pathToFileURL(require.resolve(path)).href,
      external: true,
    }));
  },
};
const load = async (options) => {
  const result = await build({
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    ...options,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
  );
};
const { PagePreview, previewNodes } = await load({
  entryPoints: [fileURLToPath(new URL("../viewer/PagePreview.jsx", import.meta.url))],
  plugins: [externalPackages],
});

// The oracle loads the actual fixed-base modules, including the card's import
// of that base's renderer. This mode can never bless current implementation output.
async function baseline() {
  return load({
    stdin: {
      contents: modules.map((name) => `export * from "./${name}";`).join("\n"),
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    plugins: [
      externalPackages,
      {
        name: "fixed-base-surfaces",
        setup(builder) {
          builder.onLoad(
            { filter: /\/model\/(page-preview|page-card|title-warning)\.mjs$/ },
            ({ path }) => ({
              contents: execFileSync(
                "git",
                ["show", `${BASE}:${modelPath}${path.split("/").at(-1)}`],
                {
                  cwd: fileURLToPath(new URL(".", import.meta.url)),
                  encoding: "utf8",
                },
              ),
              resolveDir: fileURLToPath(new URL(".", import.meta.url)),
              loader: "js",
            }),
          );
        },
      },
    ],
  });
}

const B = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: {
    type: new A.ImmutableString(type),
    parents: parents.map((p) => new A.ImmutableString(p)),
    attrs,
    isEmbed,
  },
});
const T = (value, marks = {}) => ({ type: "text", value, marks });
const link = (href, title = null) => JSON.stringify({ href, title });
const asset = `/api/pages/${PAGE_ID}/assets/${"a".repeat(64)}`;
const shapes = [
  ...Object.entries(SHAPES),
  [
    "all-marks",
    [
      T("<quoted>&", {
        link: link("https://example.org?a=1&b=2", '"tip"'),
        em: true,
        strong: true,
        strike: true,
        highlight: "#abcdef",
        code: true,
      }),
    ],
  ],
  [
    "fragmented-link",
    [
      T("the ", { link: link("/p/55555555-5555-4555-8555-555555555555") }),
      T("same", {
        strong: true,
        link: link("/p/55555555-5555-4555-8555-555555555555"),
      }),
      T(" link", { link: link("/p/55555555-5555-4555-8555-555555555555") }),
    ],
  ],
  ["marked-raw-newlines", [T("before\n\n<not html>\n", { strong: true, highlight: "blue" })]],
  [
    "native-title",
    [
      B("heading", [], { level: 2 }),
      T("Shared ", { strong: true }),
      T("title", { link: link("https://example.org") }),
    ],
  ],
  [
    "empty-before-title",
    [B("paragraph"), B("heading"), B("heading", [], { level: 6 }), T("Shared title")],
  ],
  [
    "image-before-title",
    [B("image", [], { src: asset, alt: "" }, true), B("heading"), T("Shared title")],
  ],
  [
    "hard-break-title",
    [B("heading"), T("Shared"), B("hard-break", ["heading"], {}, true), T("title")],
  ],
  ["code-hard-break", [B("code-block"), T("a"), B("hard-break", [], {}, true), T("b")]],
  ["incomplete-table", [B("table"), T("cell")]],
  ["empty-table", [B("table")]],
  ["unknown-first-in-quote", [B("blockquote"), B("future", ["blockquote"]), T("inside")]],
  [
    "unknown-first-in-task",
    [B("task-list-item", [], { checked: true }), B("future", ["task-list-item"]), T("inside")],
  ],
  [
    "theme-image",
    [
      B(
        "image",
        [],
        {
          src: asset,
          dark_src: asset.replace(/a{64}$/, "b".repeat(64)),
          alt: 'a "chart" <b>',
          title: "& figure",
          private: "hidden",
        },
        true,
      ),
    ],
  ],
  ["unsafe-image", [B("image", [], { src: "javascript:alert(1)", alt: "chart" }, true)]],
  [
    "unsafe-dark-image",
    [B("image", [], { src: asset, dark_src: "javascript:alert(1)", alt: "chart" }, true)],
  ],
  ["unsafe-link", [T("click <me>", { link: link("javascript:alert(1)") })]],
  ["scalar-image", [B("image", [], { src: asset, alt: 0, title: false }, true)]],
  ["scalar-dataframe-zero", [B("dataframe", [], { src: asset, media_type: false, title: 0 })]],
  ["scalar-dataframe-false", [B("dataframe", [], { src: asset, media_type: null, title: false })]],
  [
    "missing-dataframe-source",
    [B("dataframe", [], { media_type: "application/vnd.apache.parquet" })],
  ],
  ["missing-dataframe-media", [B("dataframe", [], { src: asset })]],
  ["missing-image-source", [B("image", [], { alt: "figure" }, true)]],
  ...["image", "hard-break"].flatMap((type) => [
    [
      `inline-block-at-end-${type}`,
      [B("paragraph"), T("before"), B(type, ["paragraph"], { src: asset })],
    ],
    [
      `inline-block-in-heading-${type}`,
      [B("heading"), T("before"), B(type, ["heading"], { src: asset })],
    ],
  ]),
  ...["table-cell", "table-header"].map((type) => [
    `cell-as-embed-${type}`,
    [B(type, [], {}, true), T("after")],
  ]),
  ...["paragraph", "heading", "blockquote", "code-block", "image", "future", null, 0].map(
    (type) => [
      `mutable-marker-${type}`,
      [
        {
          type: "block",
          value: { type, parents: [], attrs: { level: 2 }, isEmbed: false },
        },
        T("Shared title"),
      ],
    ],
  ),
  [
    "mutable-parents",
    [
      {
        type: "block",
        value: {
          type: new A.ImmutableString("paragraph"),
          parents: ["blockquote"],
          attrs: {},
          isEmbed: false,
        },
      },
      T("text"),
    ],
  ],
  ["raw-code-unknown-inline", [T("before"), B("future", ["code-block"], {}, true), T("after")]],
  [
    "mixed-raw-code-image",
    [
      {
        type: "block",
        value: { type: "code-block", parents: [], attrs: {}, isEmbed: false },
      },
      T("before"),
      B("image", [], { src: asset, alt: "figure" }, true),
      T("after"),
    ],
  ],
  [
    "mixed-raw-code-marks",
    [
      {
        type: "block",
        value: { type: "code-block", parents: [], attrs: {}, isEmbed: false },
      },
      T("before", {
        strong: true,
        em: true,
        link: link("https://example.org"),
      }),
      T("after"),
    ],
  ],
  [
    "mixed-raw-code-leaf",
    [
      {
        type: "block",
        value: {
          type: new A.ImmutableString("horizontal-rule"),
          parents: ["code-block"],
          attrs: {},
          isEmbed: false,
        },
      },
      T("after"),
    ],
  ],
  [
    "mixed-cell-dataframe",
    [
      {
        type: "block",
        value: {
          type: new A.ImmutableString("dataframe"),
          parents: ["table-cell"],
          attrs: { src: asset, media_type: "data" },
          isEmbed: false,
        },
      },
      T("after"),
    ],
  ],
  ...["blockquote", "aside", "unordered-list-item", "ordered-list-item", "task-list-item"].flatMap(
    (parent) =>
      ["horizontal-rule", "dataframe"].flatMap((type) => [
        [
          `leaf-text-${parent}-${type}`,
          [
            B(parent),
            T("before"),
            B(type, [parent], { src: asset, media_type: "data" }),
            T("after"),
          ],
        ],
        [
          `leaf-embed-${parent}-${type}`,
          [
            B(parent),
            T("before"),
            B(type, [parent], { src: asset, media_type: "data" }),
            B("hard-break", [parent], {}, true),
            T("after"),
          ],
        ],
      ]),
  ),
  ...["image", "hard-break"].flatMap((type) => [
    [`inline-as-block-${type}`, [B(type, [], { src: asset }), T("after")]],
    [
      `nested-inline-as-block-${type}`,
      [T("before"), B(type, ["paragraph"], { src: asset }), T("after")],
    ],
  ]),
  ...[
    "paragraph",
    "heading",
    "code-block",
    "blockquote",
    "horizontal-rule",
    "unordered-list-item",
    "table",
    "dataframe",
  ].flatMap((type) => [
    [
      `block-as-embed-${type}`,
      [B(type, [], { src: asset, media_type: "data" }, true), T("following")],
    ],
    [
      `nested-block-as-embed-${type}`,
      [T("before"), B(type, [], { src: asset, media_type: "data" }, true), T("following")],
    ],
    [
      `block-in-paragraph-${type}`,
      [T("before"), B(type, ["paragraph"], { src: asset, media_type: "data" }), T("following")],
    ],
  ]),
  ["task-missing-checked", [B("task-list-item"), T("task")]],
  ...[1, {}, [], "custom"].map((checked) => [
    `task-scalar-${JSON.stringify(checked)}`,
    [B("task-list-item", [], { checked }), T("task")],
  ]),
  ["task-null-checked", [B("task-list-item", [], { checked: null }), T("task")]],
  ...[null, false, 0, "", "2", 9].map((level) => [
    `heading-${JSON.stringify(level)}`,
    [B("heading", [], { level }), T("Shared title")],
  ]),
  ...[null, false, 0, "", "Python extra"].map((params) => [
    `language-${JSON.stringify(params)}`,
    [B("code-block", [], { params }), T("code\nnext")],
  ]),
  ...[null, false, 0, "", "left", "bad"].map((align) => [
    `align-${JSON.stringify(align)}`,
    [B("table-cell", ["table", "table-row"], { align }), T("cell")],
  ]),
  ...["https://example.org", "null", "{}", '""', link(null), JSON.stringify({ title: "tip" })].map(
    (value) => [`link-${value}`, [T("label", { link: value })]],
  ),
  ...["strong", "em", "strike", "code", "highlight"].flatMap((name) =>
    [false, 0, "invalid"].map((value) => [`mark-${name}-${value}`, [T("text", { [name]: value })]]),
  ),
];
const generated = fc
  .sample(pageTreeArbitrary({ hostile: true, maxDepth: 2 }), {
    seed: 4937,
    numRuns: 100,
  })
  .map((description, index) => [`generated-${index}`, encode(toWordgardTree(description))]);
const legacy = [
  "paragraph",
  "heading",
  "code-block",
  "blockquote",
  "aside",
  "unordered-list-item",
  "table",
  "table-row",
  "table-cell",
  "table-header",
  "horizontal-rule",
  "image",
  "hard-break",
  "dataframe",
  "future",
].flatMap((type) =>
  [
    "paragraph",
    "code-block",
    "table",
    "table-row",
    "table-cell",
    "horizontal-rule",
    "image",
    "future",
  ].map((parent) => [
    `legacy-${parent}-${type}`,
    [
      B(parent, [], { src: asset, media_type: "data" }),
      T("before"),
      B(type, [parent], { src: asset, media_type: "data" }),
      T("after"),
    ],
  ]),
);
const fallback = [
  ...[false, true].flatMap((rootFirst) =>
    [[], ["table-cell"]].map((parents) => {
      const root = [B("future-root"), T("first")];
      const code = [
        B("code-block", [], { params: "python" }),
        T("before"),
        B("future-widget", parents, {}, true),
        T("after"),
      ];
      return [
        `fallback-actual-code-${rootFirst}-${parents.join("-")}`,
        rootFirst ? [...root, ...code] : [...code, ...root],
      ];
    }),
  ),
  ...["dataframe", "horizontal-rule"].map((type) => [
    `mutable-leaf-empty-${type}`,
    [
      {
        type: "block",
        value: {
          type,
          parents: [],
          attrs: { src: asset, media_type: "data" },
          isEmbed: false,
        },
      },
      T("after"),
    ],
  ]),
  [
    "adjacent-embedded-cells",
    [B("table-cell", [], {}, true), B("table-header", [], {}, true), T("after")],
  ],
  ...["dataframe", "future"].flatMap((type) =>
    [true, false, null].map((value) => [
      `fallback-code-marks-${type}-${value}`,
      [
        B("code-block"),
        T("before"),
        B(type, ["code-block"], { src: asset, media_type: "data" }, type === "dataframe"),
        T("after", { em: value }),
      ],
    ]),
  ),
  [
    "notice-root-dataframe-parent-hint",
    [B("dataframe", ["table-cell"], { src: asset, media_type: "data" }, true), T("after")],
  ],
  ["notice-root-dataframe-missing-attrs", [B("dataframe", ["table-cell"], {}, true), T("after")]],
  [
    "unknown-explicit-parent-group",
    [B("future-root"), T("before"), B("paragraph", ["future-other"]), T("after")],
  ],
  [
    "notice-code-embed",
    [
      B("code-block", [], { params: "python" }),
      T("before"),
      B("dataframe", ["code-block"], { src: asset, media_type: "data", title: "Dataset" }, true),
      T("after"),
    ],
  ],
  [
    "notice-cell-embed",
    [
      B("table-cell", ["table", "table-row"]),
      T("before"),
      B(
        "dataframe",
        ["table", "table-row", "table-cell"],
        { src: asset, media_type: "data", title: "Dataset" },
        true,
      ),
      T("after"),
    ],
  ],
  [
    "unknown-parent-group",
    [B("paragraph", ["future-a"]), T("one"), B("paragraph", ["future-b"]), T("two")],
  ],
  [
    "unknown-parent-card-budget",
    Array.from({ length: 65 }, (_, i) => [
      B("paragraph", [`future-${i % 2}`]),
      T(`line${i}`),
    ]).flat(),
  ],
  ...["future", "dataframe"].flatMap((type) =>
    [["code-block"], ["table", "table-row", "table-cell"]].flatMap((parents) =>
      [false, true].flatMap((isEmbed) =>
        [false, true].map((earlierUnknown) => [
          `notice-${type}-${parents.join("-")}-${isEmbed}-${earlierUnknown}`,
          [
            ...(earlierUnknown ? [B("future-root"), T("first"), B("paragraph")] : []),
            T("before"),
            B(type, parents, { src: asset, media_type: "data" }, isEmbed),
            T("after"),
          ],
        ]),
      ),
    ),
  ),
  ...["future", "dataframe"].flatMap((type) =>
    [["code-block"], ["table", "table-row", "table-cell"]].map((parents) => [
      `notice-warning-${type}-${parents.join("-")}`,
      [
        B("heading", [], { level: 2 }),
        T("Shared title"),
        B(type, parents, { src: asset, media_type: "data" }),
        T("after"),
      ],
    ]),
  ),
];
const inputs = [...shapes, ...generated, ...legacy, ...fallback];
function page(spans) {
  return A.change(
    A.from(
      {
        title: "Shared title",
        page_id: PAGE_ID,
        blocks: {
          one: {
            id: "one",
            position: "a0",
            kind: "markdown",
            format: RICH_FORMAT,
            richText: "",
          },
        },
      },
      { actor: "0123456789abcdef0123456789abcdef" },
    ),
    { time: 0 },
    (draft) => A.updateSpans(draft, ["blocks", "one", "richText"], spans),
  );
}
const attempt = (fn) => {
  try {
    return fn();
  } catch (error) {
    return { error: error.message };
  }
};
const excerpt = (html) => {
  const dom = new JSDOM(html);
  const text = dom.window.document.body.textContent;
  dom.window.close();
  return text;
};
function observe(doc, impl) {
  const preview = impl.pagePreview(doc);
  const previewHTML = renderToStaticMarkup(
    createElement(PagePreview, { preview, pageId: PAGE_ID }),
  );
  const card = attempt(() => impl.cardContent(doc));
  const cardHTML = card.error
    ? null
    : renderToStaticMarkup(
        createElement(
          "div",
          null,
          ...card.blocks.flatMap((block) => previewNodes(block.content, block.id, { inert: true })),
        ),
      );
  return {
    preview,
    previewHTML,
    excerpt: excerpt(previewHTML),
    card,
    cardHTML,
    cardExcerpt: cardHTML === null ? null : excerpt(cardHTML),
    warning: impl.openingTitleWarning(doc),
  };
}
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reviewCases = (impl) =>
  Object.fromEntries(
    fallback.map(([name, spans]) => {
      const original = page(spans);
      const doc = A.change(original, { time: 0 }, (draft) => {
        draft.blocks.two = {
          id: "two",
          position: "a1",
          kind: "markdown",
          format: RICH_FORMAT,
          richText: "second block",
        };
      });
      try {
        return [
          name,
          [80, 120, 256, 8192].map((maxBytes) => ({
            preview: impl.pagePreview(doc, { maxBytes }),
            card: attempt(() => impl.cardContent(doc, { maxBytes })),
            warning: impl.openingTitleWarning(doc),
          })),
        ];
      } finally {
        A.free(doc);
      }
    }),
  );
const record = (name, value) =>
  /^(generated|legacy)-/.test(name) ? { sha256: digest(value) } : value;

if (process.env.PAGES_SURFACES_ORACLE === "write-fixed-base") {
  const impl = await baseline();
  const cases = {};
  for (const [name, spans] of inputs) {
    const doc = page(spans);
    try {
      cases[name] = record(name, observe(doc, impl));
    } finally {
      A.free(doc);
    }
  }
  writeFileSync(
    GOLDEN,
    `${JSON.stringify({ base: BASE, cases, review: reviewCases(impl) }, null, 2)}\n`,
  );
} else if (process.env.PAGES_SURFACES_ORACLE === "benchmark-fixed-base") {
  const impl = await baseline();
  const doc = page(
    Array.from({ length: 500 }, (_, index) => [
      B("paragraph"),
      T(`Paragraph ${index}. ${"bounded preview text ".repeat(30)}`),
    ]).flat(),
  );
  try {
    const bytes = A.save(doc);
    for (const name of ["pagePreview", "cardContent"]) {
      assert.deepEqual(current[name](doc), impl[name](doc));
      const measure = (fn) => {
        for (let i = 0; i < 3; i++) fn(doc);
        return Array.from({ length: 15 }, () => {
          const start = performance.now();
          fn(doc);
          return performance.now() - start;
        }).sort((a, b) => a - b)[7];
      };
      console.log(
        JSON.stringify({
          name,
          paragraphs: 500,
          textBytes: Buffer.byteLength(doc.blocks.one.richText),
          baseP50ms: measure(impl[name]),
          nativeP50ms: measure(current[name]),
        }),
      );
    }
    assert.deepEqual(A.save(doc), bytes);
  } finally {
    A.free(doc);
  }
} else {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  assert.equal(golden.base, BASE);
  assert.deepEqual(
    Object.keys(golden.cases),
    inputs.map(([name]) => name),
  );
  // These old renderer bugs are checked explicitly below, not frozen as a contract.
  const corrected = new Set([
    "unknown-mark",
    "unknown-embed",
    "unknown-embed-in-cell",
    "notice-future-table-table-row-table-cell-true-false",
    "notice-future-table-table-row-table-cell-true-true",
  ]);
  const unmarkedCode = new Map([
    ["fallback-code-marks-dataframe-true", "fallback-code-marks-dataframe-null"],
    ["fallback-code-marks-dataframe-false", "fallback-code-marks-dataframe-null"],
    ["fallback-code-marks-future-true", "fallback-code-marks-future-null"],
    ["fallback-code-marks-future-false", "fallback-code-marks-future-null"],
  ]);
  for (const [name, spans] of inputs) {
    if (corrected.has(name)) continue;
    test(`surface ${unmarkedCode.has(name) ? "safe unmarked-code projection" : "fixed-base parity"}: ${name}`, () => {
      const doc = page(spans);
      try {
        const bytes = A.save(doc);
        const heads = A.getHeads(doc);
        if (unmarkedCode.has(name)) assert.equal(golden.cases[name].preview.truncated, true);
        assert.deepEqual(
          record(name, observe(doc, current)),
          golden.cases[unmarkedCode.get(name) ?? name],
        );
        assert.deepEqual(A.save(doc), bytes);
        assert.deepEqual(A.getHeads(doc), heads);
      } finally {
        A.free(doc);
      }
    });
  }
  test("review regressions retain warnings, tight card budgets, and following Page blocks", () => {
    const observed = reviewCases(current);
    for (const [name, expected] of Object.entries(golden.review))
      if (!corrected.has(name))
        assert.deepEqual(
          observed[name],
          unmarkedCode.has(name) ? golden.review[unmarkedCode.get(name)] : expected,
          name,
        );
      else
        assert.ok(
          observed[name].every(({ card }) => !card.error),
          name,
        );
  });
  test("marked text after a native notice stays unmarked code without changing storage", () => {
    for (const type of ["dataframe", "future"])
      for (const marks of [
        { em: true },
        { strong: false },
        { strike: true },
        { code: true },
        { highlight: "blue" },
        { link: link("https://example.org") },
        { future: true },
      ]) {
        const doc = page([
          B("code-block"),
          T("before"),
          B(type, ["code-block"], { src: asset, media_type: "data" }, type === "dataframe"),
          T("after", marks),
        ]);
        try {
          const bytes = A.save(doc),
            heads = A.getHeads(doc);
          const spans = A.spans(doc.blocks.one, ["richText"]),
            id = A.getObjectId(doc.blocks.one);
          assert.deepEqual(observe(doc, current), golden.cases[`fallback-code-marks-${type}-null`]);
          assert.deepEqual(A.save(doc), bytes);
          assert.deepEqual(A.getHeads(doc), heads);
          assert.deepEqual(A.spans(doc.blocks.one, ["richText"]), spans);
          assert.equal(A.getObjectId(doc.blocks.one), id);
        } finally {
          A.free(doc);
        }
      }
  });
  test("unknown marks keep text, and unknown inline nodes are inert notices on the host", () => {
    for (const name of corrected) {
      const doc = page(inputs.find(([key]) => key === name)[1]);
      try {
        const observed = observe(doc, current);
        assert.equal(observed.preview.truncated, false);
        assert.equal(observed.card.error, undefined);
        assert.match(
          observed.excerpt,
          name === "unknown-mark" ? /marked/ : /Unsupported node: future/,
        );
        assert.match(
          observed.cardExcerpt,
          name === "unknown-mark" ? /marked/ : /Unsupported node: future/,
        );
        assert.notDeepEqual(observed, golden.cases[name]);
      } finally {
        A.free(doc);
      }
    }
  });
  test("hostile text, marks, and URLs stay inert; cards never retain external targets", () => {
    const poison =
      '<img src="https://tracking.example/i" onerror="alert(1)"><script>alert(2)</script>';
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (suffix) => {
        const doc = page([
          T(poison + suffix, {
            strong: true,
            future: "kept",
            link: link("javascript:alert(3)"),
          }),
          B(
            "image",
            [],
            {
              src: "javascript:alert(4)",
              dark_src: "https://tracking.example/i",
              alt: poison,
            },
            true,
          ),
          B(
            "future-mention",
            [],
            { src: "https://tracking.example/provenance", label: poison },
            true,
          ),
        ]);
        try {
          const observed = observe(doc, current);
          assert.ok(observed.excerpt.includes(poison + suffix));
          const dom = new JSDOM(observed.previewHTML + observed.cardHTML);
          try {
            assert.equal(
              dom.window.document.querySelectorAll("script, img, a[href], iframe, [onerror]")
                .length,
              0,
            );
          } finally {
            dom.window.close();
          }
          assert.equal(JSON.stringify(observed.card).includes("javascript:"), false);
          assert.match(observed.cardExcerpt, /Unsupported node: future-mention/);
        } finally {
          A.free(doc);
        }
      }),
      { seed: 4938, numRuns: 40 },
    );
  });
  test("dataframe titles cannot provide a DOM specification", () => {
    const doc = page([
      B("dataframe", [], {
        src: asset,
        media_type: "data",
        title: ["script", "alert(1)"],
      }),
    ]);
    try {
      assert.deepEqual(pagePreview(doc), {
        title: "Shared title",
        blocks: [],
        truncated: true,
      });
      assert.equal(cardContent(doc).truncated, false);
      assert.doesNotMatch(observe(doc, current).cardHTML, /<script/);
    } finally {
      A.free(doc);
    }
  });
  test("depth and output budgets reject one pathological block without reading later blocks", () => {
    const deep = page([B("paragraph", Array(65).fill("blockquote")), T("too deep")]);
    try {
      assert.deepEqual(pagePreview(deep).blocks, []);
      assert.equal(pagePreview(deep).truncated, true);
      assert.equal(cardContent(deep).truncated, true);
      assert.equal(openingTitleWarning(deep), null);
    } finally {
      A.free(deep);
    }
    const doc = page(
      Array.from({ length: 500 }, (_, index) => [
        B("paragraph"),
        T(`line ${index}: ${"<&>".repeat(20)}`),
      ]).flat(),
    );
    try {
      for (const maxBytes of [100, 1024, 4096]) {
        const preview = pagePreview(doc, { maxBytes });
        const card = cardContent(doc, { maxBytes });
        assert.equal(preview.truncated, true);
        assert.equal(card.truncated, true);
        assert.ok(Buffer.byteLength(JSON.stringify(preview)) <= maxBytes);
        assert.ok(Buffer.byteLength(JSON.stringify(card.blocks)) <= maxBytes);
      }
    } finally {
      A.free(doc);
    }
  });
  test("dataframe placeholders and inert links do not resolve labels or fetch assets", () => {
    const doc = page([
      T("private label", { link: link("https://tracking.example/resolve") }),
      B("dataframe", [], {
        src: "https://tracking.example/data",
        media_type: "data",
        title: "Dataset",
      }),
    ]);
    const previous = globalThis.fetch;
    globalThis.fetch = () => {
      throw Error("Surface performed a network read");
    };
    try {
      const observed = observe(doc, current);
      assert.equal(observed.card.error, undefined);
      assert.equal(JSON.stringify(observed.card).includes("tracking.example"), false);
      assert.match(observed.cardExcerpt, /private labelDataset/);
    } finally {
      globalThis.fetch = previous;
      A.free(doc);
    }
  });
  test("all three surface import graphs exclude ProseMirror and its adapters", async () => {
    for (const module of modules) {
      const result = await build({
        entryPoints: [fileURLToPath(new URL(module, import.meta.url))],
        bundle: true,
        write: false,
        metafile: true,
        treeShaking: false,
        platform: "browser",
        format: "esm",
      });
      assert.deepEqual(
        Object.keys(result.metafile.inputs).filter((path) =>
          /prosemirror|pm-adapter|pm-markdown-parser/.test(path),
        ),
        [],
        module,
      );
    }
  });
}
