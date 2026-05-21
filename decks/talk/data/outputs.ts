import type { NteractEmbeddableOutput } from "../../../src/components/isolated/embeddable-output";
import { ARROW_STREAM_MANIFEST_MIME } from "../../../src/components/isolated/output-manifest";
import type {
  OutputBlobRef,
  OutputBlobResolver,
  OutputManifest,
} from "../../../src/components/isolated/output-manifest";
import {
  MATHNET_AGENT_TABLE_SUMMARY,
  MATHNET_ARROW_BLOB,
  MATHNET_ARROW_PATH,
  MATHNET_ARROW_ROW_COUNT,
} from "./mathnet-arrow";

const blobFixtures: Record<string, { body: string; mediaType: string }> = {
  "mathnet-problem-card": {
    mediaType: "text/html",
    body: `
<div class="mathnet-card">
  <p class="eyebrow">ShadenA/MathNet · geometry · optional diagram column</p>
  <h3>Problem: Ratio in a triangle</h3>
  <p>In triangle ABC, points D and E lie on AB and AC respectively. If DE is
  parallel to BC and AD:DB = 2:3, what is the ratio of the area of ADE to ABC?</p>
  <p class="answer">final_answer: 4/25</p>
</div>
<style>
  .mathnet-card {
    border-left: 4px solid #2563eb;
    padding: 0.75rem 1rem;
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  .mathnet-card .eyebrow {
    color: #64748b;
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    margin: 0 0 0.4rem;
    text-transform: uppercase;
  }
  .mathnet-card h3 {
    margin: 0 0 0.35rem;
    font-size: 1.05rem;
  }
  .mathnet-card p {
    margin: 0 0 0.5rem;
    color: #4b5563;
  }
  .mathnet-card .answer {
    color: #0f172a;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    margin-bottom: 0;
  }
</style>`,
  },
};

export const demoBlobResolver: OutputBlobResolver = {
  url(ref: OutputBlobRef) {
    if (ref.blob === MATHNET_ARROW_BLOB && typeof window !== "undefined") {
      return new URL(MATHNET_ARROW_PATH, window.location.origin).toString();
    }
    return `https://example.invalid/nteract-output/${encodeURIComponent(ref.blob)}`;
  },
  async fetch(ref: OutputBlobRef) {
    const fixture = blobFixtures[ref.blob];
    if (!fixture) {
      return new Response(`missing blob fixture: ${ref.blob}`, { status: 404 });
    }
    return new Response(fixture.body, {
      headers: {
        "Content-Type": fixture.mediaType,
      },
    });
  },
};

export const agentReplOutputs: NteractEmbeddableOutput[] = [
  {
    output_type: "stream",
    name: "stdout",
    text: [
      "agent$ python",
      ">>> from datasets import load_dataset",
      ">>> ds = load_dataset('ShadenA/MathNet', split='train[:100]')",
      ">>> ds.features",
      "",
    ].join("\n"),
  } as NteractEmbeddableOutput,
  {
    output_type: "display_data",
    data: {
      "text/markdown": [
        "### Observation",
        "",
        "The REPL gives the agent a real inspection loop:",
        "",
        "- `problem_markdown` is long-form text, not a scalar metric",
        "- rows carry provenance like `country`, `competition`, and `language`",
        "- some rows include image columns that should stay inspectable",
      ].join("\n"),
    },
    metadata: {},
  } as NteractEmbeddableOutput,
];

export const mathnetDataFrameOutput: OutputManifest = {
  output_type: "execute_result",
  execution_count: 12,
  data: {
    [ARROW_STREAM_MANIFEST_MIME]: {
      inline: JSON.stringify({
        version: 1,
        content_type: "application/vnd.apache.arrow.stream",
        chunks: [
          {
            index: 0,
            hash: MATHNET_ARROW_BLOB,
            size: 0,
            row_count: MATHNET_ARROW_ROW_COUNT,
          },
        ],
        complete: true,
      }),
    },
    "text/llm+plain": {
      inline: MATHNET_AGENT_TABLE_SUMMARY,
    },
  },
  metadata: {},
};

export const mathnetProblemManifest: OutputManifest = {
  output_type: "display_data",
  data: {
    "text/html": {
      blob: "mathnet-problem-card",
      media_type: "text/html",
    },
  },
  metadata: {},
};
