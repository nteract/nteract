"use client";

import { BookOpenText, Link2, Pilcrow, Table2 } from "lucide-react";
import { useCallback } from "react";
import { ProjectedMarkdownView } from "@/components/markdown/ProjectedMarkdownView";
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
  measurement: { estimatedHeight: 720, confidence: "high", width: 760 },
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
    block(6, "checklist-heading", "heading", "h2", "Experiment checklist"),
    block(7, "checklist", "list", "ul", "tasks"),
    block(8, "math", "math", "div", "\\mathbb{E}[L_t] \\leq \\epsilon + \\lambda\\|A_t-A_0\\|_2"),
    block(
      9,
      "code",
      "code",
      "pre",
      "from topicdiff import schedule\nschedule.fit(k=8, prior='sparse')",
      {
        codeLanguage: "python",
      },
    ),
    block(
      10,
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
      listItemIndex: 2,
      listItemPath: "2",
      semantic: "list-item",
    }),
    run("math", "math-source", "\\mathbb{E}[L_t] \\leq \\epsilon + \\lambda\\|A_t-A_0\\|_2", {
      semantic: "math-source",
    }),
    run("closing", "closing-text", "The rendered markdown should feel like a "),
    run("closing", "closing-em", "paper margin", { semantic: "emphasis" }),
    run("closing", "closing-tail", " and a runnable lab bench at the same time."),
  ],
};

const auditRows = [
  {
    icon: Link2,
    label: "Link affordance",
    detail: "Always visible underline, stronger decoration on hover and focus.",
  },
  {
    icon: Pilcrow,
    label: "Document rhythm",
    detail: "Section spacing, subdued list markers, and legible paragraph measure.",
  },
  {
    icon: Table2,
    label: "Dense evidence",
    detail: "Tables use notebook tokens without becoming heavy spreadsheet chrome.",
  },
  {
    icon: BookOpenText,
    label: "Research voice",
    detail: "Cream switches markdown to the serif document font used by output frames.",
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

      <section className="grid gap-4 min-[1500px]:grid-cols-[minmax(0,1fr)_320px]">
        <article className="min-w-0 border border-border bg-background px-7 py-6 text-foreground shadow-sm max-sm:pr-5 max-sm:pl-14">
          <ProjectedMarkdownView plan={markdownPlan} onLinkClick={handleLinkClick} />
        </article>

        <aside className="grid content-start gap-3 border border-border bg-muted/20 p-4 text-foreground">
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
      </section>

      <section className="grid gap-4 min-[1500px]:grid-cols-2">
        <article
          className="min-w-0 border border-border bg-background px-6 py-5 text-foreground max-sm:pr-5 max-sm:pl-14"
          data-color-theme="classic"
        >
          <div className="mb-3 font-mono text-[11px] text-muted-foreground">classic tokens</div>
          <ProjectedMarkdownView
            colorTheme="classic"
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
            plan={markdownPlan}
            onLinkClick={handleLinkClick}
          />
        </article>
      </section>
    </div>
  );
}
