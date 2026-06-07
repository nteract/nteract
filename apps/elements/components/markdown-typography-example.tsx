"use client";

import { BookOpenText, Image, Link2, Pilcrow, Table2 } from "lucide-react";
import { useCallback } from "react";
import { ProjectedMarkdownView } from "@/components/markdown/ProjectedMarkdownView";
import {
  markdownDetailsBodyClassName,
  markdownDetailsClassName,
  markdownInlineCodeClassName,
  markdownLinkClassName,
  markdownParagraphClassName,
  markdownSummaryClassName,
  markdownSummaryIndicatorClassName,
} from "@/components/markdown/markdown-typography";
import type {
  MarkdownProjectionBlock,
  MarkdownProjectionPlan,
  MarkdownProjectionRun,
} from "../../../src/lib/markdown-projection";
import { NotebookPaletteToggle } from "./notebook-palette-toggle";

const measurement = { estimatedHeight: 36, confidence: "high", width: 760 } as const;
const emptySpan = [0, 0] as const;

function block(
  blockIndex: number,
  blockId: string,
  kind: MarkdownProjectionBlock["kind"],
  element: string,
  text: string,
  overrides: Partial<MarkdownProjectionBlock> = {},
): MarkdownProjectionBlock {
  return {
    blockId,
    blockIndex,
    element,
    kind,
    measurement,
    sourceSpanByte: emptySpan,
    sourceSpanUtf16: emptySpan,
    syntaxSpans: [],
    text,
    ...overrides,
  };
}

function run(
  blockId: string,
  inlineId: string,
  renderedText: string,
  overrides: Partial<MarkdownProjectionRun> = {},
): MarkdownProjectionRun {
  return {
    blockId,
    inlineId,
    listItemIndex: null,
    renderedText,
    renderedTextUtf16: [0, renderedText.length],
    semantic: "text",
    sourceSpanByte: emptySpan,
    sourceSpanUtf16: emptySpan,
    ...overrides,
  };
}

const markdownPlan: MarkdownProjectionPlan = {
  version: 1,
  engine: "elements-fixture",
  byteLength: 0,
  utf16Length: 0,
  measurement: { estimatedHeight: 780, confidence: "high", width: 760 },
  anchors: [
    {
      anchorId: "elements-markdown-claim",
      blockId: "claim",
      level: 2,
      slug: "claim",
      sourceSpanByte: emptySpan,
      sourceSpanUtf16: emptySpan,
      title: "Claim",
    },
  ],
  blocks: [
    block(0, "title", "heading", "h1", "Discrete diffusion notebook"),
    block(
      1,
      "lead",
      "paragraph",
      "p",
      "A compact research note that links sources, states a model, and keeps code close to the claim.",
    ),
    block(2, "claim", "heading", "h2", "Claim", { anchorSlug: "claim" }),
    block(
      3,
      "claim-body",
      "blockquote",
      "blockquote",
      "Local perturbations preserve topic topology when the denoising schedule is bounded.",
    ),
    block(4, "evidence", "heading", "h2", "Evidence table"),
    block(5, "table", "table", "table", "metric baseline candidate delta"),
    block(6, "mixed-table", "table", "table", "artifact example score note"),
    block(7, "ledger", "heading", "h3", "Observation ledger"),
    block(8, "nested-list", "list", "ol", "notes", { ordered: true }),
    block(9, "figure", "paragraph", "p", "Residual topology sketch"),
    block(10, "checklist-heading", "heading", "h2", "Experiment checklist"),
    block(11, "checklist", "list", "ul", "tasks"),
    block(12, "math", "math", "div", "\\mathbb{E}[L_t] \\leq \\epsilon + \\lambda\\|A_t-A_0\\|_2"),
    block(13, "bound", "paragraph", "p", "where beta controls the experimental tolerance."),
    block(
      14,
      "code",
      "code",
      "pre",
      "from topicdiff import schedule\nschedule.fit(k=8, prior='sparse')",
      {
        codeLanguage: "python",
      },
    ),
    block(15, "rule", "thematic-break", "hr", ""),
    block(
      16,
      "closing",
      "paragraph",
      "p",
      "The rendered markdown should feel like a paper margin and a runnable lab bench at the same time.",
    ),
  ],
  runs: [
    run("title", "title-text", "Discrete diffusion notebook"),
    run("lead", "lead-0", "A compact research note that links "),
    run("lead", "lead-link", "source material", {
      href: "https://example.com/source-material",
      title: "Source material",
    }),
    run("lead", "lead-1", ", states a "),
    run("lead", "lead-code", "latent transition model", { semantic: "inline-code" }),
    run("lead", "lead-2", ", and keeps code close to the claim."),
    run("claim", "claim-text", "Claim"),
    run("claim-body", "claim-body-text", "Local perturbations preserve topic topology when the "),
    run("claim-body", "claim-body-strong", "denoising schedule", { semantic: "strong" }),
    run("claim-body", "claim-body-tail", " is bounded."),
    run("evidence", "evidence-text", "Evidence table"),
    run("table", "table-h0", "metric", {
      tableCellHeader: true,
      tableCellIndex: 0,
      tableRowIndex: 0,
    }),
    run("table", "table-h1", "baseline", {
      tableCellHeader: true,
      tableCellIndex: 1,
      tableRowIndex: 0,
    }),
    run("table", "table-h2", "candidate", {
      tableCellHeader: true,
      tableCellIndex: 2,
      tableRowIndex: 0,
    }),
    run("table", "table-r1c0", "topic stability", { tableCellIndex: 0, tableRowIndex: 1 }),
    run("table", "table-r1c1", "0.72", {
      tableCellAlign: "right",
      tableCellIndex: 1,
      tableRowIndex: 1,
    }),
    run("table", "table-r1c2", "0.84", {
      tableCellAlign: "right",
      tableCellIndex: 2,
      tableRowIndex: 1,
    }),
    run("table", "table-r2c0", "review latency", { tableCellIndex: 0, tableRowIndex: 2 }),
    run("table", "table-r2c1", "18m", {
      tableCellAlign: "right",
      tableCellIndex: 1,
      tableRowIndex: 2,
    }),
    run("table", "table-r2c2", "11m", {
      tableCellAlign: "right",
      tableCellIndex: 2,
      tableRowIndex: 2,
    }),
    run("mixed-table", "mixed-h0", "artifact", {
      tableCellHeader: true,
      tableCellIndex: 0,
      tableRowIndex: 0,
    }),
    run("mixed-table", "mixed-h1", "example", {
      tableCellHeader: true,
      tableCellIndex: 1,
      tableRowIndex: 0,
    }),
    run("mixed-table", "mixed-h2", "score", {
      tableCellHeader: true,
      tableCellIndex: 2,
      tableRowIndex: 0,
    }),
    run("mixed-table", "mixed-h3", "note", {
      tableCellHeader: true,
      tableCellIndex: 3,
      tableRowIndex: 0,
    }),
    run("mixed-table", "mixed-r1c0", "dataset", { tableCellIndex: 0, tableRowIndex: 1 }),
    run("mixed-table", "mixed-r1c1", "topicdiff/cache", {
      semantic: "inline-code",
      tableCellIndex: 1,
      tableRowIndex: 1,
    }),
    run("mixed-table", "mixed-r1c2", "1,284", { tableCellIndex: 2, tableRowIndex: 1 }),
    run("mixed-table", "mixed-r1c3a", "source ", { tableCellIndex: 3, tableRowIndex: 1 }),
    run("mixed-table", "mixed-r1c3b", "cell", {
      href: "https://example.com/source-cell",
      tableCellIndex: 3,
      tableRowIndex: 1,
    }),
    run("mixed-table", "mixed-r2c0", "change", { tableCellIndex: 0, tableRowIndex: 2 }),
    run("mixed-table", "mixed-r2c1", "+7.2%", { tableCellIndex: 1, tableRowIndex: 2 }),
    run("mixed-table", "mixed-r2c2", "0.91", { tableCellIndex: 2, tableRowIndex: 2 }),
    run("mixed-table", "mixed-r2c3", "pilot", {
      semantic: "emphasis",
      tableCellIndex: 3,
      tableRowIndex: 2,
    }),
    run("mixed-table", "mixed-r3c0", "reviewed", { tableCellIndex: 0, tableRowIndex: 3 }),
    run("mixed-table", "mixed-r3c1", "2026-06-07", { tableCellIndex: 1, tableRowIndex: 3 }),
    run("mixed-table", "mixed-r3c2", "3", { tableCellIndex: 2, tableRowIndex: 3 }),
    run("mixed-table", "mixed-r3c3", "seed=13", {
      semantic: "inline-code",
      tableCellIndex: 3,
      tableRowIndex: 3,
    }),
    run("mixed-table", "mixed-r4c0", "state", { tableCellIndex: 0, tableRowIndex: 4 }),
    run("mixed-table", "mixed-r4c1", "bounded", {
      semantic: "strong",
      tableCellIndex: 1,
      tableRowIndex: 4,
    }),
    run("mixed-table", "mixed-r4c2", "98%", { tableCellIndex: 2, tableRowIndex: 4 }),
    run("mixed-table", "mixed-r4c3", "ready", { tableCellIndex: 3, tableRowIndex: 4 }),
    run("ledger", "ledger-text", "Observation ledger"),
    run("nested-list", "nested-0", "Treat the schedule as a bounded operator", {
      listItemIndex: 0,
      listItemOrdered: true,
      listItemPath: "0",
      semantic: "list-item",
    }),
    run("nested-list", "nested-0-0", "Measure local topic neighborhoods after every prior update", {
      listItemIndex: 0,
      listItemOrdered: false,
      listItemPath: "0.0",
      semantic: "list-item",
    }),
    run("nested-list", "nested-1a", "Escalate drift into a ", {
      listItemIndex: 1,
      listItemOrdered: true,
      listItemPath: "1",
      semantic: "list-item",
    }),
    run("nested-list", "nested-1b", "follow-up cell", {
      href: "https://example.com/follow-up",
      listItemIndex: 1,
      listItemOrdered: true,
      listItemPath: "1",
      semantic: "list-item",
    }),
    run("figure", "figure-image", "Residual topology sketch", {
      imageAlt: "Residual topology sketch",
      imageSrc: "/fixtures/widget-buffer-url-image.svg",
      imageTitle: "Residual topology sketch",
      semantic: "image",
    }),
    run("checklist-heading", "checklist-heading-text", "Experiment checklist"),
    run("checklist", "task-0", "Reproduce the baseline paper", {
      listItemChecked: true,
      listItemIndex: 0,
      listItemPath: "0",
      semantic: "list-item",
    }),
    run("checklist", "task-1a", "Compare against the ", {
      listItemChecked: false,
      listItemIndex: 1,
      listItemPath: "1",
      semantic: "list-item",
    }),
    run("checklist", "task-1b", "interactive notebook", {
      href: "https://example.com/notebook",
      listItemIndex: 1,
      listItemPath: "1",
      semantic: "list-item",
    }),
    run("checklist", "task-2", "Promote surprising failures into follow-up cells", {
      listItemChecked: false,
      listItemIndex: 2,
      listItemPath: "2",
      semantic: "list-item",
    }),
    run("math", "math-source", "\\mathbb{E}[L_t] \\leq \\epsilon + \\lambda\\|A_t-A_0\\|_2", {
      semantic: "math-source",
    }),
    run("bound", "bound-0", "where "),
    run("bound", "bound-beta", "\\beta", { semantic: "math-source" }),
    run("bound", "bound-1", " controls the experimental tolerance."),
    run("closing", "closing-text", "The rendered markdown should feel like a "),
    run("closing", "closing-em", "paper margin", { semantic: "emphasis" }),
    run("closing", "closing-tail", " and a runnable lab bench at the same time."),
  ],
};

const headingAnchors = [
  {
    anchor: "discrete-diffusion-notebook",
    headingAnchorId: "elements-markdown-heading-discrete-diffusion-notebook",
    itemId: "elements-markdown:title",
    level: 1,
    title: "Discrete diffusion notebook",
  },
  {
    anchor: "claim",
    headingAnchorId: "elements-markdown-heading-claim",
    itemId: "elements-markdown:claim",
    level: 2,
    title: "Claim",
  },
  {
    anchor: "evidence-table",
    headingAnchorId: "elements-markdown-heading-evidence-table",
    itemId: "elements-markdown:evidence",
    level: 2,
    title: "Evidence table",
  },
  {
    anchor: "observation-ledger",
    headingAnchorId: "elements-markdown-heading-observation-ledger",
    itemId: "elements-markdown:ledger",
    level: 3,
    title: "Observation ledger",
  },
  {
    anchor: "experiment-checklist",
    headingAnchorId: "elements-markdown-heading-experiment-checklist",
    itemId: "elements-markdown:checklist",
    level: 2,
    title: "Experiment checklist",
  },
] as const;

const auditRows = [
  {
    icon: Link2,
    label: "Link affordance",
    detail: "Always visible underline, stronger decoration on hover and focus.",
  },
  {
    icon: Pilcrow,
    label: "Anchorable sections",
    detail: "Headings expose quiet permalink anchors from the notebook outline metadata.",
  },
  {
    icon: Table2,
    label: "Dense evidence",
    detail: "Tables use notebook tokens without becoming heavy spreadsheet chrome.",
  },
  {
    icon: Image,
    label: "Figure rhythm",
    detail: "Images sit in the document flow with a quiet boundary and reusable output tokens.",
  },
  {
    icon: BookOpenText,
    label: "Research voice",
    detail: "Cream switches markdown to the serif document font used by output frames.",
  },
  {
    icon: BookOpenText,
    label: "Appendix motion",
    detail: "Native disclosure blocks read as compact experimental appendices.",
  },
];

export function MarkdownTypographyExample() {
  const handleLinkClick = useCallback((url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  return (
    <div className="not-prose space-y-6" data-elements-slot="markdown-typography">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fd-foreground">Markdown document surface</h2>
          <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
            Production projected markdown rendered with a dense notebook-style fixture.
          </p>
        </div>
        <NotebookPaletteToggle />
      </div>

      <section className="space-y-4">
        <article className="mx-auto min-w-0 max-w-[980px] border border-border bg-background px-7 py-6 text-foreground shadow-sm max-sm:pr-5 max-sm:pl-14">
          <ProjectedMarkdownView
            headingAnchors={headingAnchors}
            plan={markdownPlan}
            onLinkClick={handleLinkClick}
          />
        </article>

        <details className={markdownDetailsClassName}>
          <summary className={markdownSummaryClassName}>
            <span aria-hidden="true" className={markdownSummaryIndicatorClassName}>
              ›
            </span>
            <span className="min-w-0">Typography audit notes</span>
          </summary>
          <aside className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {auditRows.map((row) => {
              const Icon = row.icon;
              return (
                <div key={row.label} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
                  <Icon className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{row.label}</div>
                    <div className="mt-1 text-xs leading-5 text-muted-foreground">{row.detail}</div>
                  </div>
                </div>
              );
            })}
          </aside>
        </details>
      </section>

      <section className="border border-border bg-background px-7 py-6 text-foreground shadow-sm max-sm:pr-5 max-sm:pl-14">
        <div className="mb-4 font-mono text-[11px] text-muted-foreground">
          shared native markdown affordance
        </div>
        <details className={markdownDetailsClassName} open>
          <summary className={markdownSummaryClassName}>
            <span aria-hidden="true" className={markdownSummaryIndicatorClassName}>
              ›
            </span>
            <span className="min-w-0">Appendix: surprising failure modes</span>
          </summary>
          <div className={markdownDetailsBodyClassName}>
            <p className={markdownParagraphClassName}>
              Keep compact digressions close to the claim: failed priors, odd notebook states, and{" "}
              <code className={markdownInlineCodeClassName}>seed=13</code> observations can hide in
              a native disclosure block without losing their place in the paper-like flow.
            </p>
            <p className={markdownParagraphClassName}>
              The appendix can still carry a{" "}
              <a href="https://example.com/appendix" className={markdownLinkClassName}>
                visible citation
              </a>{" "}
              and should feel tactile before the reader opens it.
            </p>
          </div>
        </details>
      </section>

      <section className="grid gap-4 min-[1500px]:grid-cols-2">
        <article
          className="min-w-0 border border-border bg-background px-6 py-5 text-foreground max-sm:pr-5 max-sm:pl-14"
          data-color-theme="classic"
        >
          <div className="mb-3 font-mono text-[11px] text-muted-foreground">classic tokens</div>
          <ProjectedMarkdownView
            colorTheme="classic"
            headingAnchors={headingAnchors}
            plan={markdownPlan}
            onLinkClick={handleLinkClick}
          />
        </article>
        <article
          className="min-w-0 border border-border bg-background px-6 py-5 text-foreground max-sm:pr-5 max-sm:pl-14"
          data-color-theme="cream"
        >
          <div className="mb-3 font-mono text-[11px] text-muted-foreground">cream tokens</div>
          <ProjectedMarkdownView
            colorTheme="cream"
            headingAnchors={headingAnchors}
            plan={markdownPlan}
            onLinkClick={handleLinkClick}
          />
        </article>
      </section>
    </div>
  );
}
