"use client";

import { useState } from "react";
import { ProjectedMarkdownView } from "@/components/markdown/ProjectedMarkdownView";
import { NotebookPaletteToggle } from "./notebook-palette-toggle";

const initialSource = `flowchart LR
  accTitle: Notebook execution
  subgraph Notebook
    A[Edit source] --> B[Sync document]
  end
  B --> C{Kernel ready?}
  C -->|Yes| D[Execute cell]
  C -->|No| E[Start kernel]
  E --> D
  D --> F[Display output]`;

/** Deterministic fixture for the shared Mermaid renderer. */
export function MermaidExample() {
  const [source, setSource] = useState(initialSource);
  const measurement = { estimatedHeight: 240, confidence: "low", width: 720 } as const;
  return (
    <section
      className="not-prose space-y-4 border border-border bg-background p-5 text-foreground"
      data-elements-slot="mermaid"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Mermaid diagrams</h2>
        <NotebookPaletteToggle />
      </div>
      <label className="block space-y-2 text-sm">
        <span>Diagram source</span>
        <textarea
          className="block min-h-48 w-full rounded border border-border bg-muted p-3 font-mono text-xs"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          spellCheck={false}
        />
      </label>
      <div data-mermaid-path="projected">
        <h3 className="text-xs text-muted-foreground">Projected Markdown cell</h3>
        <ProjectedMarkdownView
          plan={{
            version: 1,
            engine: "elements-fixture",
            byteLength: 0,
            utf16Length: 0,
            measurement,
            anchors: [],
            runs: [],
            blocks: [
              {
                blockId: "mermaid-fixture",
                blockIndex: 0,
                kind: "mermaid",
                element: "div",
                codeLanguage: "mermaid",
                text: source,
                measurement,
                sourceSpanByte: [0, 0],
                sourceSpanUtf16: [0, 0],
                syntaxSpans: [],
              },
            ],
          }}
        />
      </div>
    </section>
  );
}
